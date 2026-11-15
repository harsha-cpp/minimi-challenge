import type { ServerResponse } from "node:http";

// At most one Node writable buffer plus this bounded application queue is retained per client.
export class SseChannel {
  private queue: string[] = [];
  private queuedBytes = 0;
  private blocked = false;
  private closed = false;
  private finishing = false;
  private cancelled = false;
  private slowTimer?: ReturnType<typeof setTimeout>;
  private heartbeat: ReturnType<typeof setInterval>;
  constructor(private res: ServerResponse, private cancel: () => void,
    private maxBytes = 262_144, private slowMs = 5000) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.on("drain", () => { this.blocked = false; clearTimeout(this.slowTimer); this.flush(); });
    res.on("close", () => { if (!res.writableEnded) this.cancelOnce(); this.dispose(); });
    this.heartbeat = setInterval(() => this.write(": heartbeat\n\n"), 15_000);
    this.heartbeat.unref();
  }
  send(event: unknown): void { this.write(`data: ${JSON.stringify(event)}\n\n`); }
  private write(data: string): void {
    if (this.closed || this.finishing) return;
    const bytes = Buffer.byteLength(data);
    if (bytes + this.queuedBytes + this.res.writableLength > this.maxBytes) return this.overflow();
    this.queue.push(data); this.queuedBytes += bytes; this.flush();
  }
  private flush(): void {
    while (!this.closed && !this.blocked && this.queue.length) {
      const value = this.queue.shift()!; this.queuedBytes -= Buffer.byteLength(value);
      if (!this.res.write(value)) {
        this.blocked = true;
        this.slowTimer = setTimeout(() => this.overflow(), this.slowMs); this.slowTimer.unref();
      }
    }
    if (this.finishing && !this.blocked && !this.queue.length && !this.closed) { this.res.end(); this.dispose(); }
  }
  end(): void { this.finishing = true; this.flush(); }
  private cancelOnce(): void { if (!this.cancelled) { this.cancelled = true; this.cancel(); } }
  private overflow(): void { this.cancelOnce(); this.dispose(); this.res.destroy(); }
  private dispose(): void { this.closed = true; clearInterval(this.heartbeat); clearTimeout(this.slowTimer); this.queue = []; this.queuedBytes = 0; }
}
