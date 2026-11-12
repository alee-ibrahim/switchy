/**
 * NDI discovery + routing service.
 *
 * - One shared finder polls sources (non-blocking) once a second.
 * - Extra IPs: NDI_EXTRA_IPS plus (by default) every configured camera host,
 *   so cameras on another subnet are found without mDNS.
 * - Routers ("virtual NDI sources") are created per room program output.
 * If the runtime is unavailable everything degrades to a logged no-op.
 */
import { EventEmitter } from 'node:events';
import { loadNdi, ndiLoadError, type NdiApi, type NdiSource } from './runtime.js';

export type { NdiSource } from './runtime.js';

export interface NdiRouter {
  readonly name: string;
  /** Point the virtual source at another NDI source. null = clear (black). */
  route(source: NdiSource | null): boolean;
  connections(): number;
  destroy(): void;
}

export interface NdiStatus {
  available: boolean;
  version: string | null;
  libraryPath: string | null;
  error: string | null;
  extraIps: string[];
  groups: string | null;
  sources: NdiSource[];
}

export interface NdiServiceOptions {
  extraIps?: string[];
  groups?: string | null;
  autoExtraIps?: boolean;
  pollMs?: number;
}

export class NdiService extends EventEmitter<{ sources: [NdiSource[]] }> {
  readonly api: NdiApi | null;
  private finder: unknown = null;
  private timer: NodeJS.Timeout | null = null;
  private envExtra: string[];
  private autoExtra: string[] = [];
  private currentExtra = '';
  private groups: string | null;
  private autoExtraIps: boolean;
  private pollMs: number;
  sources: NdiSource[] = [];

  constructor(opts: NdiServiceOptions = {}, api: NdiApi | null | undefined = undefined) {
    super();
    this.api = api === undefined ? loadNdi() : api;
    this.envExtra = opts.extraIps ?? [];
    this.groups = opts.groups ?? null;
    this.autoExtraIps = opts.autoExtraIps ?? true;
    this.pollMs = opts.pollMs ?? 1000;
  }

  get available(): boolean {
    return this.api !== null;
  }

  status(): NdiStatus {
    return {
      available: this.available,
      version: this.api?.version ?? null,
      libraryPath: this.api?.libraryPath ?? null,
      error: this.api ? null : ndiLoadError(),
      extraIps: this.extraIps(),
      groups: this.groups,
      sources: this.sources,
    };
  }

  private extraIps(): string[] {
    return [...new Set([...this.envExtra, ...(this.autoExtraIps ? this.autoExtra : [])])].filter(Boolean);
  }

  /** Hosts of configured cameras; recreates the finder if the set changed. */
  setCameraHosts(hosts: string[]): void {
    this.autoExtra = [...new Set(hosts.map((h) => h.trim()).filter((h) => /^[\d.]+$/.test(h)))].sort();
    if (this.timer && this.extraIps().join(',') !== this.currentExtra) this.recreateFinder();
  }

  start(): void {
    if (!this.api || this.timer) return;
    this.recreateFinder();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  private recreateFinder() {
    if (!this.api) return;
    if (this.finder) this.api.findDestroy(this.finder);
    this.currentExtra = this.extraIps().join(',');
    this.finder = this.api.findCreate({ showLocal: true, groups: this.groups, extraIps: this.currentExtra || null });
  }

  private poll() {
    if (!this.api || !this.finder) return;
    try {
      this.api.findWait(this.finder, 0);
      const list = this.api.findSources(this.finder).sort((a, b) => a.name.localeCompare(b.name));
      const key = (l: NdiSource[]) => l.map((s) => `${s.name}|${s.url}`).join('\n');
      if (key(list) !== key(this.sources)) {
        this.sources = list;
        this.emit('sources', list);
      }
    } catch {
      /* ignore transient errors */
    }
  }

  /** Find a discovered source by exact (then case-insensitive) name. */
  resolve(name: string): NdiSource | null {
    return (
      this.sources.find((s) => s.name === name) ??
      this.sources.find((s) => s.name.toLowerCase() === name.toLowerCase()) ??
      null
    );
  }

  createRouter(name: string): NdiRouter | null {
    const api = this.api;
    if (!api) return null;
    const inst = api.routingCreate(name, this.groups);
    if (!inst) return null;
    let destroyed = false;
    return {
      name,
      route: (src) => (destroyed ? false : src ? api.routingChange(inst, src) : api.routingClear(inst)),
      connections: () => (destroyed ? 0 : api.routingConnections(inst, 0)),
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        api.routingDestroy(inst);
      },
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.api && this.finder) this.api.findDestroy(this.finder);
    this.finder = null;
  }
}
