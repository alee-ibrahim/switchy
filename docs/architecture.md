# Architecture

## How a switch happens

When a delegate switches on their microphone on a **Brähler DCen** conference system, Switchy:

1. cuts the room's program to the wide camera,
2. sends the PTZ camera to that seat's preset,
3. waits for it to settle (and, optionally, touches up the framing or starts tracking the speaker, see [tracking.md](tracking.md)),
4. and then cuts the program to the PTZ.

Each room gets its own **NDI program output**, e.g. `Switchy (Committee Room A Program)`. Recorders, streamers and vision mixers subscribe to that output instead of to the individual cameras. No OBS and no hardware switcher are involved.

## Building blocks

- **Microphone events.** Switchy makes a read-only TCP connection to the DCen central unit (port 3225, ASCII) and never sends anything to it. See [hardware.md](hardware.md#brähler-dcen) and `src/engine/dcen/`.
- **Program output via NDI routing (cut-only).** Switchy publishes one virtual NDI source per room with `NDIlib_routing_*`. To cut, it re-points that source at a different camera's NDI stream.
  - No video passes through the server, so CPU use is close to zero.
  - Receivers reconnect at each cut, so there is a short hitch.
  - A future "switcher" output mode (decode, mix, re-encode) slots in behind the `ProgramOutput` interface (`src/engine/output/program.ts`).
- **Camera control** goes through a driver interface (`src/engine/cameras/types.ts`) with `birddog`, `visca` and `none` drivers. See [hardware.md](hardware.md#cameras).
- **Switching policy, per room:**
  - last-speaker or first-speaker mode;
  - optional chair priority;
  - 300 ms debounce;
  - when a speaker stops, the camera goes to the most recent remaining speaker;
  - when nobody is speaking, back to wide after a configurable delay;
  - a new speaker in the middle of a camera move cancels that move and restarts;
  - the same preset is never re-sent twice in a row;
  - a one-camera room either shows the move live or shows a holding NDI source while the camera moves.

## Stack

TypeScript end to end:

- Node 22+ with Fastify.
- Drizzle ORM with PostgreSQL.
- Vite, React and official shadcn/ui components, served by the same process.
- **koffi** for the FFI into the NDI runtime. koffi ships prebuilt binaries, so there's no native compile step and no NDI headers are needed at build time.
- onnxruntime-node for the face and person models (CPU).

## Layout

```
src/engine/        switching engine (no HTTP/DB dependencies; can be split into its own process)
  dcen/            DCen parser + read-only TCP client
  cameras/         driver interface, BirdDog REST, VISCA-over-IP
  ndi/             NDI runtime loader (koffi) + discovery/routing service + frame grabs
  image/           JPEG encode/resize (jpeg-js)
  autoframe/       face detection (YuNet), PTZ calibration, framing, refine step, active tracking
  output/          ProgramOutput interface (route mode; future switcher mode)
  room/            speaker policy + per-room state machine
src/api/           Fastify routes, SSE, auth hook
src/db/            Drizzle schema + repository
web/               Vite + React + shadcn/ui
drizzle/           SQL migrations
docs/              documentation
```

## Development

- Production build: `npm run build && npm start` (serves `dist/` and `web/dist/`). Container: see the `Dockerfile` and `docker compose --profile app up` (Linux hosts only, host networking). More in [deploy.md](deploy.md).
- Optional hot-reload UI: `npm run dev:web` serves on http://localhost:5180 and proxies `/api`.
- Database migrations are in `drizzle/` and run automatically on startup. After changing `src/db/schema.ts`, run `npm run db:generate`.
- Checks: `npm test`, `npm run typecheck`, `npm run build`. The parser and state-machine tests replay a recorded DCen session from `test/fixtures/`. Auto-framing tests use person-free room frames (`test/fixtures/autoframe/`). Frames with people stay out of the repo: put them in `test/fixtures/private/` (git-ignored) and run `npm run models`, and the real-detector tests run too. Tests that need the downloaded models or private frames are skipped when those are missing (as in CI).

## Limitations

- **Cut-only output.** NDI routing re-points receivers at a camera, so there are no transitions and receivers show a short hitch at each cut. Receivers need a network path to every camera, not just to Switchy.
- **One microphone system.** Only the Brähler DCen is supported as a source of microphone events. After a reconnect Switchy assumes all mics are off.
- **Sony VISCA untested.** The `visca` driver follows the Sony VISCA-over-IP framing but has not been run against a real BRC-X400.
- **Tracking tuned on one camera.** Speed tables and quirks (stale position replies, broken relative tilt) were measured on the BirdDog P100.
- **Single process.** Engine, API and UI run in one process, one instance per site. The event log is an in-memory ring (300 entries per room).
- **Containers need host networking** for NDI discovery (or an NDI Discovery Server); Docker host networking only works on Linux.
- **Auth** is either off or delegated to a reverse proxy; there is no built-in login.
