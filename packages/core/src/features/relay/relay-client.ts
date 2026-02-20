import { EventEmitter } from 'events';
import { createRequire } from 'module';
import WebSocket from 'ws';
import {
  BotUserCommand,
  RelayControlMessage,
  RelayReport,
  HeartbeatReport,
  CommandAckReport,
  IncomingRelayMessage,
} from '../../shared/protocol.js';
import { createLogger, sanitizeUrl } from '../../shared/logger.js';

const logger = createLogger('RelayClient');

type RelayClientState = 'DISCONNECTED' | 'CONNECTING' | 'AWAITING_PAIRING' | 'CONNECTED';

export interface RelayClientConfig {
  host: string;
  apiKey: string;
  pairingId?: string;
  pairingCode?: string;
}

export interface StatusUpdate {
  strategy_status?: string;
  connected_venues?: string[];
  open_orders?: number;
  open_positions?: number;
  strategy_metrics?: {
    signals_received: number;
    signals_matched: number;
    trades_generated: number;
    trades_rejected_by_risk: number;
    dry_run_trades: number;
    signals_dropped_stale_or_duplicate: number;
  };
}

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: RelayClientConfig;
  private _state: RelayClientState = 'DISCONNECTED';
  private _pairingId: string | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000; // Start at 1s
  private readonly maxReconnectDelay = 60000; // Max 60s
  private readonly heartbeatIntervalMs = 15000; // 15s
  private shouldReconnect = true;
  private startTime: number = Date.now();

  // Heartbeat status fields
  private version = '0.1.0';
  private strategyStatus: string = 'active';
  private connectedVenues: string[] = [];
  private openOrders = 0;
  private openPositions = 0;
  private strategyMetrics?: StatusUpdate['strategy_metrics'];

  constructor(config: RelayClientConfig) {
    super();
    this.config = config;
    this._pairingId = config.pairingId ?? null;

    // Load version from package.json if available
    try {
      const esmRequire = createRequire(import.meta.url);
      const pkg = esmRequire('../../../package.json');
      this.version = pkg.version ?? '0.1.0';
    } catch {
      // Fallback already set
    }
  }

  get state(): RelayClientState {
    return this._state;
  }

  get pairingId(): string | null {
    return this._pairingId;
  }

  /**
   * Update bot status fields that are sent in heartbeat reports.
   */
  updateStatus(update: StatusUpdate): void {
    if (update.strategy_status !== undefined) {
      this.strategyStatus = update.strategy_status;
    }
    if (update.connected_venues !== undefined) {
      this.connectedVenues = update.connected_venues;
    }
    if (update.open_orders !== undefined) {
      this.openOrders = update.open_orders;
    }
    if (update.open_positions !== undefined) {
      this.openPositions = update.open_positions;
    }
    if (update.strategy_metrics !== undefined) {
      this.strategyMetrics = update.strategy_metrics;
    }
  }

  /**
   * Connect to the relay server.
   * Uses pairing_code on first connect, pairing_id on reconnect.
   */
  connect(): void {
    if (this._state !== 'DISCONNECTED') {
      logger.warn({ state: this._state }, 'connect() called but not in DISCONNECTED state');
      return;
    }

    this.shouldReconnect = true;
    this._state = 'CONNECTING';

    const url = this.buildWebSocketUrl();
    const sanitized = sanitizeUrl(url);
    logger.info({ url: sanitized }, 'Connecting to relay server');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('WebSocket connection opened');
      this._state = this._pairingId ? 'CONNECTED' : 'AWAITING_PAIRING';
      this.reconnectDelay = 1000; // Reset backoff on successful connection
      this.startHeartbeat();

      if (this._pairingId) {
        this.emit('connected');
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.info({ code, reason: reason.toString() }, 'WebSocket closed');
      this.handleDisconnect();
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'WebSocket error');
      this.handleDisconnect();
    });
  }

  /**
   * Disconnect from the relay server and stop reconnection attempts.
   */
  disconnect(): void {
    logger.info('Disconnecting from relay server');
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimeout();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this._state = 'DISCONNECTED';
    this.emit('disconnected');
  }

  /**
   * Send a report to the relay server.
   * If disconnected, logs a warning and does not send.
   */
  sendReport(report: RelayReport): void {
    if (this._state !== 'CONNECTED') {
      logger.warn({ state: this._state, reportType: report.type }, 'Cannot send report: not connected');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ reportType: report.type }, 'Cannot send report: WebSocket not open');
      return;
    }

    const json = JSON.stringify(report);
    this.ws.send(json);
    logger.debug({ reportType: report.type }, 'Sent report');
  }

  private buildWebSocketUrl(): string {
    const { host, apiKey, pairingCode } = this.config;

    // If the host already includes a scheme, use it as-is
    let base: string;
    if (host.startsWith('ws://') || host.startsWith('wss://')) {
      base = `${host}/api/v1/relay?api_key=${apiKey}`;
    } else {
      const scheme = this.isPlainWsHost(host) ? 'ws' : 'wss';
      base = `${scheme}://${host}/api/v1/relay?api_key=${apiKey}`;
    }

    if (this._pairingId) {
      return `${base}&pairing_id=${this._pairingId}`;
    } else if (pairingCode) {
      return `${base}&pairing_code=${pairingCode}`;
    } else {
      throw new Error('RelayClient requires either pairingId or pairingCode to connect');
    }
  }

  /** Returns true if the host looks like a local/private address that should use plain ws:// */
  private isPlainWsHost(host: string): boolean {
    // Strip port if present
    const hostname = host.includes(':') ? host.split(':')[0] : host;
    return (
      hostname === 'localhost' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('100.') || // Tailscale CGNAT range
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  }

  private handleMessage(data: WebSocket.Data): void {
    let message: IncomingRelayMessage;

    try {
      const raw = data.toString();
      message = JSON.parse(raw) as IncomingRelayMessage;
    } catch (err) {
      logger.error({ err }, 'Failed to parse incoming message');
      return;
    }

    logger.debug({ type: message.type }, 'Received message');

    switch (message.type) {
      case 'pairing_confirmed':
        this.handlePairingConfirmed(message);
        break;
      case 'pairing_revoked':
        this.handlePairingRevoked(message);
        break;
      case 'trade':
      case 'cancel':
      case 'cancel_all':
      case 'pause':
      case 'resume':
        this.handleCommand(message);
        break;
      default:
        logger.warn({ type: (message as any).type }, 'Unknown message type');
    }
  }

  private handlePairingConfirmed(message: RelayControlMessage & { type: 'pairing_confirmed' }): void {
    logger.info(
      { pairing_id: message.pairing_id, relay_session_id: message.relay_session_id },
      'Pairing confirmed'
    );
    this._pairingId = message.pairing_id;
    this._state = 'CONNECTED';
    this.emit('pairing_confirmed', message);
    this.emit('connected');
  }

  private handlePairingRevoked(message: RelayControlMessage & { type: 'pairing_revoked' }): void {
    logger.warn({ pairing_id: message.pairing_id, reason: message.reason }, 'Pairing revoked');
    this.emit('pairing_revoked', message);
    this.disconnect();
  }

  private handleCommand(command: BotUserCommand): void {
    if (command.type === 'trade') {
      logger.info({
        command_type: command.type,
        command_id: command.id,
        venue: command.venue,
        market_id: command.market_id,
        side: command.side,
        action: command.action,
        size: command.size,
        order_type: command.order_type,
        limit_price: command.limit_price,
      }, 'Received trade command');
    } else {
      logger.info({ command_type: command.type, command_id: command.id }, 'Received command');
    }
    this.emit('command', command);

    // Auto-send acknowledgment
    const ack: CommandAckReport = {
      type: 'command_ack',
      command_id: command.id,
      status: 'accepted',
    };
    this.sendReport(ack);
  }

  private handleDisconnect(): void {
    this.stopHeartbeat();

    const wasConnected = this._state === 'CONNECTED';
    this._state = 'DISCONNECTED';

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    if (wasConnected) {
      this.emit('disconnected');
    }

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimeout();

    logger.info({ delay_ms: this.reconnectDelay }, 'Scheduling reconnection');

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff with max cap
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat(): void {
    const uptime_secs = Math.floor((Date.now() - this.startTime) / 1000);

    const heartbeat: HeartbeatReport = {
      type: 'heartbeat',
      uptime_secs,
      version: this.version,
      strategy_status: this.strategyStatus,
      connected_venues: this.connectedVenues,
      open_orders: this.openOrders,
      open_positions: this.openPositions,
      strategy_metrics: this.strategyMetrics,
    };

    this.sendReport(heartbeat);
  }
}
