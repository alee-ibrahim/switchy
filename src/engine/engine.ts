/**
 * The switching engine: one runtime per room (DCen client + camera drivers +
 * program output + controller). Kept independent of HTTP/DB so it can later
 * run as its own process (hostNetwork pod on the AV VLAN) with the API elsewhere.
 */
import { EventEmitter } from 'node:events';
import { DcenClient } from './dcen/client.js';
import { createDriver, type CameraDriver } from './cameras/index.js';
import { createProgramOutput, type ProgramOutput } from './output/program.js';
import { NdiService } from './ndi/service.js';
import { RoomController, type RoomEvent, type RoomSnapshot, type ShotRefiner, type ShotTracker } from './room/controller.js';
import type { CameraConfig, RoomConfig, SeatConfig } from './types.js';

export interface EngineEvent {
  roomId: string;
  event: RoomEvent;
}

interface RoomRuntime {
  config: RoomConfig;
  controller: RoomController;
  dcen: DcenClient | null;
  drivers: Map<string, CameraDriver>;
  output: ProgramOutput;
  log: RoomEvent[];
}

const LOG_KEEP = 300;

export type EngineLogger = (roomName: string, e: RoomEvent) => void;

export interface EngineOptions {
  /** Camera driver factory (tests inject fakes). */
  createDriver?: (cam: CameraConfig) => CameraDriver;
  /** Refine step implementation (auto-framing) for rooms with policy.refine != 'off'. */
  refiner?: ShotRefiner;
  /** Active tracking implementation for rooms with policy.refine = 'track'. */
  tracker?: ShotTracker;
  refinePrepare?: (camera: CameraConfig) => void;
  /** Idle PTZ sanity check interval (ms; 0 = off). Default 20000. */
  sanityCheckMs?: number;
}

/** Longest wait for the explicit camera stops before a room's drivers are closed. */
const STOP_WAIT_MS = 1500;

export class Engine extends EventEmitter<{ event: [EngineEvent] }> {
  private rooms = new Map<string, RoomRuntime>();

  private makeDriver: (cam: CameraConfig) => CameraDriver;

  constructor(
    readonly ndi: NdiService,
    private logger?: EngineLogger,
    private opts: EngineOptions = {},
  ) {
    super();
    this.makeDriver = opts.createDriver ?? createDriver;
  }

  start(configs: RoomConfig[]) {
    this.ndi.start();
    for (const c of configs) this.upsertRoom(c);
  }

  private refreshCameraHosts() {
    const hosts: string[] = [];
    for (const r of this.rooms.values()) for (const c of r.config.cameras) if (c.host) hosts.push(c.host);
    this.ndi.setCameraHosts(hosts);
  }

  /** (Re)start a room with new config. */
  upsertRoom(config: RoomConfig) {
    const old = this.rooms.get(config.id);
    const keptLog = old?.log ?? [];
    // a config edit must not silently resume automation that an operator paused
    const wasPaused = old?.controller.snapshot().paused ?? false;
    if (old) this.teardown(old);
    if (!config.enabled) {
      this.rooms.delete(config.id);
      this.refreshCameraHosts();
      return;
    }

    const drivers = new Map<string, CameraDriver>();
    for (const cam of config.cameras) drivers.set(cam.id, this.makeDriver(cam));
    const output = createProgramOutput(config, this.ndi);
    const controller = new RoomController(config, {
      drivers,
      output,
      refiner: this.opts.refiner,
      tracker: this.opts.tracker,
      refinePrepare: this.opts.refinePrepare,
    });
    const rt: RoomRuntime = { config, controller, dcen: null, drivers, output, log: keptLog };
    controller.on('event', (e) => {
      if (e.type === 'log') {
        rt.log.push(e);
        if (rt.log.length > LOG_KEEP) rt.log.splice(0, rt.log.length - LOG_KEEP);
        this.logger?.(config.name, e);
      }
      this.emit('event', { roomId: config.id, event: e });
    });
    this.rooms.set(config.id, rt);
    this.refreshCameraHosts();
    controller.log('info', `room started; program output "${config.outputName}" (${output.mode})`);
    if (wasPaused) controller.setPaused(true);
    controller.startSafety(this.opts.sanityCheckMs ?? 20_000);

    if (config.dcenHost) {
      const dcen = new DcenClient({ host: config.dcenHost, port: config.dcenPort });
      dcen.on('connected', ({ local }) => controller.setDcenConnected(true, `${config.dcenHost}:${config.dcenPort} (local ${local})`));
      dcen.on('disconnected', ({ reason, retryInMs }) =>
        controller.setDcenConnected(false, `${reason}; retry in ${Math.round(retryInMs / 1000)}s`),
      );
      dcen.on('event', (ev) => {
        if (ev.type !== 'keepalive' && ev.type !== 'setting') controller.log('debug', `RX ${ev.raw}`);
        controller.handleDcen(ev);
      });
      rt.dcen = dcen;
      dcen.start();
    } else {
      controller.log('warn', 'no DCen host configured; automation idle');
    }
  }

  removeRoom(id: string) {
    const rt = this.rooms.get(id);
    if (!rt) return;
    this.teardown(rt);
    this.rooms.delete(id);
    this.refreshCameraHosts();
  }

  /** Stop a room. The camera stops are sent first; the drivers are closed once they went out (at most STOP_WAIT_MS). */
  private teardown(rt: RoomRuntime): Promise<void> {
    rt.dcen?.stop();
    const stopped = rt.controller.dispose();
    rt.controller.removeAllListeners();
    rt.output.close();
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<void>((r) => {
      timer = setTimeout(r, STOP_WAIT_MS);
    });
    return Promise.race([stopped, wait]).then(() => {
      clearTimeout(timer);
      for (const d of rt.drivers.values()) d.close?.();
    });
  }

  /** Update a running room's seat map in place (no restart, no DCen reconnect). */
  updateSeats(id: string, seats: SeatConfig[]): boolean {
    const rt = this.rooms.get(id);
    if (!rt) return false;
    rt.config = { ...rt.config, seats };
    rt.controller.updateSeats(seats);
    return true;
  }

  /**
   * Replace one camera's options in a running room in place (no restart: the
   * driver, DCen connection, pause state and program are kept). Used for data
   * the drivers do not depend on, e.g. stored preset coordinates.
   */
  updateCameraOptions(id: string, cameraId: string, options: Record<string, unknown>): boolean {
    const rt = this.rooms.get(id);
    if (!rt) return false;
    const cameras = rt.config.cameras.map((c) => (c.id === cameraId ? { ...c, options } : c));
    rt.config = { ...rt.config, cameras };
    rt.controller.updateCameras(cameras);
    return true;
  }

  roomConfig(id: string): RoomConfig | undefined {
    return this.rooms.get(id)?.config;
  }

  room(id: string): RoomController | undefined {
    return this.rooms.get(id)?.controller;
  }

  snapshot(id: string): (RoomSnapshot & { log: RoomEvent[]; connections: number }) | null {
    const rt = this.rooms.get(id);
    if (!rt) return null;
    return { ...rt.controller.snapshot(), log: [...rt.log], connections: rt.output.connections() };
  }

  driver(roomId: string, cameraId: string): CameraDriver | undefined {
    return this.rooms.get(roomId)?.drivers.get(cameraId);
  }

  /** Stop all rooms; resolves once the camera stops were sent and the drivers closed. */
  async stop(): Promise<void> {
    const all = [...this.rooms.values()].map((rt) => this.teardown(rt));
    this.rooms.clear();
    await Promise.all(all);
    this.ndi.stop();
  }
}
