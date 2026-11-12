/**
 * Read-only TCP client for a Brähler DCen central unit.
 *
 * IMPORTANT: this client never writes a single byte to the DCen. It only
 * listens. Several clients may be connected at once.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { LineSplitter, parseLine, type DcenEvent } from './parser.js';

export interface DcenClientOptions {
  host: string;
  port: number;
  /** Flush an unterminated line after this much quiet (ms). */
  flushMs?: number;
  connectTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Reconnect if nothing (not even a keep-alive) arrives for this long. 0 = off. */
  idleTimeoutMs?: number;
}

export interface DcenClientEvents {
  event: [DcenEvent];
  connected: [{ local: string }];
  disconnected: [{ reason: string; retryInMs: number }];
}

export class DcenClient extends EventEmitter<DcenClientEvents> {
  private sock: net.Socket | null = null;
  private splitter = new LineSplitter();
  private flushTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private backoff: number;
  private stopped = true;
  connected = false;
  lastRxAt = 0;

  readonly opts: Required<DcenClientOptions>;

  constructor(opts: DcenClientOptions) {
    super();
    this.opts = {
      flushMs: 300,
      connectTimeoutMs: 5000,
      minBackoffMs: 1000,
      maxBackoffMs: 30000,
      idleTimeoutMs: 0,
      ...opts,
    };
    this.backoff = this.opts.minBackoffMs;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.sock?.destroy();
    this.sock = null;
    this.connected = false;
  }

  private clearTimers() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.flushTimer = this.idleTimer = null;
  }

  private connect() {
    if (this.stopped) return;
    this.splitter.reset();
    const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.sock = sock;
    sock.setEncoding('latin1');
    sock.setNoDelay(true);
    let failed = false;
    const fail = (reason: string) => {
      if (failed) return;
      failed = true;
      this.onDown(sock, reason);
    };
    sock.setTimeout(this.opts.connectTimeoutMs, () => fail('connect timeout'));
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.setKeepAlive(true, 10_000);
      this.connected = true;
      this.backoff = this.opts.minBackoffMs;
      this.lastRxAt = Date.now();
      this.armIdle();
      this.emit('connected', { local: `${sock.localAddress}:${sock.localPort}` });
    });
    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('error', (e) => fail(e.message));
    sock.on('close', () => fail('connection closed by DCen'));
  }

  private armIdle() {
    if (!this.opts.idleTimeoutMs) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.sock?.destroy(new Error(`no data for ${this.opts.idleTimeoutMs} ms`));
    }, this.opts.idleTimeoutMs);
  }

  private onData(chunk: string) {
    this.lastRxAt = Date.now();
    this.armIdle();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const line of this.splitter.push(chunk)) this.emit('event', parseLine(line));
    if (this.splitter.hasPending) {
      this.flushTimer = setTimeout(() => {
        const p = this.splitter.flush();
        if (p !== null) this.emit('event', parseLine(p));
      }, this.opts.flushMs);
    }
  }

  private onDown(sock: net.Socket, reason: string) {
    if (this.sock !== sock) return;
    sock.destroy();
    this.sock = null;
    this.clearTimers();
    const wasConnected = this.connected;
    this.connected = false;
    if (this.stopped) return;
    const retryInMs = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    this.emit('disconnected', { reason: wasConnected ? reason : `connect failed: ${reason}`, retryInMs });
    this.retryTimer = setTimeout(() => this.connect(), retryInMs);
  }
}
