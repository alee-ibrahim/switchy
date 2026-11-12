/**
 * Program output per room.
 *
 * MVP: RoutedProgramOutput uses NDI routing - a virtual NDI source that is
 * re-pointed at the live camera. No video passes through Switchy; a cut
 * causes a short hitch in receivers while they reconnect.
 *
 * Seam for later: a "switcher" output (receive + decode + re-encode, real
 * transitions, no hitch) implements the same interface and is selected by
 * RoomConfig.outputMode.
 */
import type { NdiService, NdiRouter } from '../ndi/service.js';
import type { RoomConfig } from '../types.js';

export interface ShowResult {
  ok: boolean;
  /** Source name was not in the discovered list (routed by name only). */
  unresolved?: boolean;
  error?: string;
}

export interface ProgramOutput {
  readonly name: string;
  readonly mode: string;
  /** Show this NDI source on program. null/empty = clear. */
  show(sourceName: string | null): ShowResult;
  readonly current: string | null;
  connections(): number;
  close(): void;
}

export class RoutedProgramOutput implements ProgramOutput {
  readonly mode = 'route';
  current: string | null = null;
  private router: NdiRouter | null;

  constructor(
    readonly name: string,
    private ndi: NdiService,
  ) {
    this.router = ndi.createRouter(name);
  }

  show(sourceName: string | null): ShowResult {
    this.current = sourceName || null;
    if (!this.router) return { ok: false, error: 'NDI runtime not available' };
    if (!sourceName) return { ok: this.router.route(null) };
    const src = this.ndi.resolve(sourceName);
    const ok = this.router.route(src ?? { name: sourceName, url: null });
    return { ok, unresolved: !src };
  }

  connections(): number {
    return this.router?.connections() ?? 0;
  }

  close(): void {
    this.router?.destroy();
    this.router = null;
  }
}

export function createProgramOutput(room: RoomConfig, ndi: NdiService): ProgramOutput {
  switch (room.outputMode) {
    case 'route':
    default:
      return new RoutedProgramOutput(room.outputName, ndi);
  }
}
