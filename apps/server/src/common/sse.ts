import type { ServerResponse } from 'node:http';
import type { ChatStreamEvent } from '@health-ai/shared';

export interface StreamSink {
  send(frame: ChatStreamEvent, signal?: AbortSignal): Promise<void>;
}

export function encodeEvent(frame: ChatStreamEvent): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

// Only one outstanding write; heartbeat is skipped under backpressure rather
// than queued. A slow or disconnected consumer cannot grow a write queue.
export class SseWriter implements StreamSink {
  private readonly connection = new AbortController();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private writing = false;
  private ended = false;
  private readonly onClose = () => {
    if (!this.ended) this.disconnect();
  };
  private readonly onError = () => this.disconnect();

  constructor(
    private readonly raw: ServerResponse,
    private readonly onDisconnect: () => void,
    heartbeatMs = 15_000,
    private readonly drainTimeoutMs = 10_000,
  ) {
    raw.on('close', this.onClose);
    raw.on('error', this.onError);
    this.heartbeat = setInterval(() => {
      if (!this.writing && !this.ended && !this.connection.signal.aborted) {
        void this.write(': ping\n\n').catch(() => this.disconnect());
      }
    }, heartbeatMs);
    this.heartbeat.unref();
    if (raw.destroyed) this.disconnect();
  }

  async send(frame: ChatStreamEvent, signal?: AbortSignal): Promise<void> {
    // The service serializes content/terminal frames. Wait for a heartbeat's
    // drain without adding more data to the socket buffer.
    while (this.writing) await this.waitForDrain(signal);
    await this.write(encodeEvent(frame), signal);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.heartbeat);
    this.raw.off('close', this.onClose);
    // Keep the error listener until the raw response is closed.
    if (this.raw.destroyed) this.raw.off('error', this.onError);
    else this.raw.once('close', () => this.raw.off('error', this.onError));
    if (!this.raw.destroyed && !this.raw.writableEnded) this.raw.end();
  }

  private disconnect(): void {
    if (this.connection.signal.aborted) return;
    clearInterval(this.heartbeat);
    this.connection.abort();
    if (!this.ended) this.onDisconnect();
  }

  private async write(data: string, signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.connection.signal]) : this.connection.signal;
    combined.throwIfAborted();
    if (this.ended || this.raw.destroyed || this.raw.writableEnded) throw new Error('Stream closed');
    this.writing = true;
    try {
      if (!this.raw.write(data)) await this.waitForDrain(combined);
    } finally {
      this.writing = false;
    }
  }

  private waitForDrain(signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.connection.signal]) : this.connection.signal;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.raw.off('drain', drained);
        combined.removeEventListener('abort', aborted);
      };
      const drained = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(new Error('Stream interrupted')); };
      const timer = setTimeout(() => {
        cleanup();
        this.disconnect();
        this.raw.destroy();
        reject(new Error('Stream backpressure timeout'));
      }, this.drainTimeoutMs);
      this.raw.once('drain', drained);
      combined.addEventListener('abort', aborted, { once: true });
      if (combined.aborted || this.raw.destroyed) aborted();
    });
  }
}
