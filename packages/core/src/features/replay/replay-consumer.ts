// ============================================================
// ReplayConsumer - HTTP client for paginated signal replay
//
// Fetches historical signals from /api/v1/public/signals/replay
// using cursor-based pagination. Returns an async generator for
// memory-efficient streaming.
// ============================================================

import type { Signal } from '../signals/signal-consumer.js';

export interface ReplayConsumerConfig {
  apiUrl: string;
  apiKey: string;
  start: Date;
  end: Date;
  signalNames?: string[];
  signalType?: 'alert' | 'strategy';
  minConfidence?: number;
  severities?: string[];
  venues?: string[];
  pageSize?: number;
}

interface ReplayApiResponse {
  signals: Signal[];
  next_cursor: string | null;
  has_more: boolean;
  count: number;
}

export class ReplayConsumer {
  private config: ReplayConsumerConfig;
  private totalFetched = 0;

  constructor(config: ReplayConsumerConfig) {
    this.config = config;
  }

  async *fetchSignals(): AsyncGenerator<Signal[], void, undefined> {
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        start: this.config.start.toISOString(),
        end: this.config.end.toISOString(),
        limit: String(this.config.pageSize ?? 1000),
      });

      if (this.config.signalNames?.length) {
        params.set('signal_names', this.config.signalNames.join(','));
      }
      if (this.config.signalType) params.set('signal_type', this.config.signalType);
      if (this.config.minConfidence != null) params.set('min_confidence', String(this.config.minConfidence));
      if (this.config.severities?.length) params.set('severities', this.config.severities.join(','));
      if (this.config.venues?.length) params.set('venues', this.config.venues.join(','));
      if (cursor) params.set('cursor', cursor);

      const url = `${this.config.apiUrl}/api/v1/public/signals/replay?${params}`;
      const response = await fetch(url, {
        headers: {
          'X-API-Key': this.config.apiKey,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Replay API error ${response.status}: ${body}`);
      }

      const data: ReplayApiResponse = await response.json();
      this.totalFetched += data.signals.length;

      yield data.signals;

      cursor = data.next_cursor;
      hasMore = data.has_more;
    }
  }

  get signalsFetched(): number {
    return this.totalFetched;
  }
}
