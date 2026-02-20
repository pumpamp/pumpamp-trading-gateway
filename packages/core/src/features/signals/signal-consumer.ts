// SignalConsumer - WebSocket client for PumpAmp public signal stream
//
// Example usage:
//
//   const consumer = new SignalConsumer({
//     host: 'api.pumpamp.com',
//     apiKey: 'pa_live_xxx',
//     signalTypes: ['alert', 'strategy'],
//     symbols: ['BTC/USDT'],
//     minConfidence: 0.7,
//   });
//
//   consumer.on('signal', (signal) => {
//     console.log('Received signal:', signal.signal_name, signal.description);
//   });
//
//   consumer.on('connected', () => {
//     console.log('Connected to signal stream');
//   });
//
//   consumer.on('disconnected', () => {
//     console.log('Disconnected from signal stream');
//   });
//
//   consumer.connect();

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createLogger, sanitizeUrl } from '../../shared/logger.js';

const logger = createLogger('SignalConsumer');

export type SignalType = 'alert' | 'strategy' | 'cross_venue_arbitrage';

export type SignalDirection =
  | 'above'
  | 'below'
  | 'cross'
  | 'long'
  | 'short'
  | 'neutral';

export type AlertSeverity = 'Low' | 'Medium' | 'High' | 'Critical';

export interface Signal {
  id: string;
  signal_type: SignalType;
  signal_name: string;
  market_id: string;
  venue: string;
  base_currency: string;
  quote_currency: string;
  created_at: string;
  triggered_at?: string;
  severity?: AlertSeverity;
  direction?: SignalDirection;
  confidence?: string; // Decimal as string
  description: string;
  payload: unknown; // SignalPayload union (versioned)
  triggered_signal_ids?: string[];
  expires_at?: string;
  matched_windows?: string[];
}

// --- Subscribe Message ---

interface SubscribeMessage {
  type: 'subscribe';
  signal_types?: string[];
  symbols?: string[];
  min_confidence?: number;
}

// --- SignalConsumer Options ---

export interface SignalConsumerOptions {
  host: string;
  apiKey: string;
  signalTypes?: string[];
  symbols?: string[];
  minConfidence?: number;
}

// --- Events ---

export interface SignalConsumerEvents {
  signal: (signal: Signal) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}

// EventEmitter with typed events
export declare interface SignalConsumer {
  on<U extends keyof SignalConsumerEvents>(event: U, listener: SignalConsumerEvents[U]): this;
  emit<U extends keyof SignalConsumerEvents>(
    event: U,
    ...args: Parameters<SignalConsumerEvents[U]>
  ): boolean;
}

// --- SignalConsumer Class ---

export class SignalConsumer extends EventEmitter {
  private readonly host: string;
  private readonly apiKey: string;
  private readonly subscribeMessage: SubscribeMessage;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false;

  // Exponential backoff config (1s, 2s, 4s, 8s, ... 60s max)
  private readonly MIN_RECONNECT_DELAY_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 60000;

  constructor(options: SignalConsumerOptions) {
    super();
    this.host = options.host;
    this.apiKey = options.apiKey;

    // Build subscribe message
    this.subscribeMessage = {
      type: 'subscribe',
      signal_types: options.signalTypes,
      symbols: options.symbols,
      min_confidence: options.minConfidence,
    };
  }

  /**
   * Connect to the public signal WebSocket endpoint.
   * Will automatically reconnect on disconnection.
   */
  connect(): void {
    if (this.ws) {
      logger.warn('SignalConsumer already connected');
      return;
    }

    this.shouldReconnect = true;
    this.attemptConnection();
  }

  /**
   * Disconnect from the signal stream and stop reconnection attempts.
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('SignalConsumer disconnected');
  }

  /**
   * Attempt to establish a WebSocket connection.
   */
  private attemptConnection(): void {
    const scheme = this.host.startsWith('localhost') || this.host.startsWith('127.0.0.1') ? 'ws' : 'wss';
    const url = `${scheme}://${this.host}/api/v1/public/ws/signals?api_key=${this.apiKey}`;
    const safeUrl = sanitizeUrl(url);

    logger.info({ url: safeUrl }, 'Connecting to signal stream');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info({ url: safeUrl }, 'Signal stream connected');
      this.reconnectAttempt = 0; // Reset backoff on successful connection
      this.emit('connected');
      this.sendSubscribe();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', () => {
      logger.info({ url: safeUrl }, 'Signal stream disconnected');
      this.ws = null;
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ url: safeUrl, error: err.message }, 'Signal stream error');
      this.emit('error', err);
    });
  }

  /**
   * Send subscribe message to the server.
   */
  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Cannot send subscribe message - WebSocket not open');
      return;
    }

    const msg = JSON.stringify(this.subscribeMessage);
    this.ws.send(msg);
    logger.debug({ subscribeMessage: this.subscribeMessage }, 'Sent subscribe message');
  }

  /**
   * Handle incoming WebSocket message.
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const text = data.toString();
      const parsed = JSON.parse(text);

      // Check if it's a Signal object (has id, signal_type, market_id)
      if (parsed && typeof parsed === 'object' && 'id' in parsed && 'signal_type' in parsed) {
        this.emit('signal', parsed as Signal);
      } else {
        // Other message types (e.g., server acks, errors) - log but don't emit
        logger.debug({ message: parsed }, 'Received non-signal message');
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ error: error.message }, 'Failed to parse signal message');
      // Do NOT emit signal event for invalid JSON
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    // Calculate delay: min(2^attempt * base, max)
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempt) * this.MIN_RECONNECT_DELAY_MS,
      this.MAX_RECONNECT_DELAY_MS
    );

    logger.info(
      { attempt: this.reconnectAttempt + 1, delayMs: delay },
      'Scheduling reconnection'
    );

    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnection();
    }, delay);
  }
}
