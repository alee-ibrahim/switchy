# Switchy

Automatic, microphone-triggered camera switching for conference and committee rooms, with optional speaker tracking and a per-room NDI® program output.

When a delegate switches on their microphone on a **Brähler DCen** conference system, Switchy:

1. cuts the room's program to the wide camera,
2. sends the PTZ camera to that seat's preset,
3. waits for it to settle (and, optionally, touches up the framing or starts tracking the speaker),
4. and then cuts the program to the PTZ.

Each room gets its own **NDI program output**, e.g. `Switchy (Committee Room A Program)`. Recorders, streamers and vision mixers subscribe to that output instead of to the individual cameras. No OBS and no hardware switcher are involved.

Switchy was built for and tested in a parliament committee room. It is early software (v0.1): it runs one room in daily use, but expect rough edges.

License: **AGPL-3.0-only** (see [`LICENSE`](LICENSE)).

## Features

- **Mic-triggered switching** from Brähler DCen microphone events (read-only connection; nothing is ever sent to the DCen).
- **Per-room switching policy:** last- or first-speaker, chair priority, debounce, back to wide when nobody speaks, cancel-and-restart on a new speaker mid-move, one-camera rooms with a live move or a holding source.
- **NDI program output per room** via NDI routing: no video passes through the server, so CPU use is close to zero.
- **PTZ control** over BirdDog REST and VISCA-over-IP: preset recall and store, jog, zoom, position.
- **Seat presets from the browser:** aim with a live preview (works on a phone) and save the preset for the seat whose mic is on, with a thumbnail.
- **Auto-framing (optional):** a light face-based touch-up after the preset recall (YuNet on the CPU), with person-free calibration.
- **Active tracking (optional):** keeps the speaker framed with slow pan/tilt velocity drive, a shot-quality gate that only puts the PTZ on air while the shot is good, a head/upper-body fallback detector, and learned per-seat preset corrections.
- **Web UI** (React + shadcn/ui) for rooms, cameras, seats and a live view with the event log; server-sent events for live state.
- **Proxy auth mode** for running behind an OIDC reverse proxy.

## Supported hardware

| Device | How | Status |
| --- | --- | --- |
| Brähler DCen central unit | read-only TCP, port 3225, ASCII status lines | tested |
| BirdDog X1 / X1 Ultra, P100 | REST on :8080 (presets) + VISCA-over-IP on UDP 52381 (jog, zoom, position, tracking) | tested |
| Sony BRC-X400 and similar | VISCA-over-IP (Sony framing) on UDP 52381 | implemented, **untested** on real hardware |
| Any NDI camera or source | as a fixed (wide) camera or a holding source | tested |

Other VISCA-over-IP PTZ cameras will probably work with the `visca` driver. Tracking speeds and quirks were measured on the BirdDog P100; other cameras may need tuning (see the per-camera overrides under Active tracking).

## Architecture

- **Microphone events.** Switchy makes a read-only TCP connection to the DCen central unit (port 3225, ASCII). The central unit sends plain-text status lines on this port of its network interface during normal operation; Switchy parses `MIC-ON`, `MIC-OFF` and `READY` from them and never sends anything to the DCen. See `src/engine/dcen/`.
  - `MIC-OFF;FFFF;FFFF;` ("all off") is honoured **only in the connect status dump**, i.e. before `READY;` (or within 5 s of connecting if `READY;` never comes). The DCen also sends it at random times while a mic is still on; after `READY;` it is logged as a warning and ignored.
- **Program output via NDI routing (cut-only).** Switchy publishes one virtual NDI source per room with `NDIlib_routing_*`. To cut, it re-points that source at a different camera's NDI stream.
  - No video passes through the server, so CPU use is close to zero.
  - Receivers reconnect at each cut, so there is a short hitch.
  - A future "switcher" output mode (decode, mix, re-encode) slots in behind the `ProgramOutput` interface (`src/engine/output/program.ts`).
- **Camera control** goes through a driver interface (`src/engine/cameras/types.ts`):
  - `birddog`: BirdDog REST on :8080: `POST /recall` and `POST /save` with `{"Preset":"Preset-N"}` (save answers `{"Save-Preset":"N"}`; presets above 9 work). Tested with the X1 Ultra and P100. Jog, zoom and position use VISCA-over-IP on UDP 52381 (on by default; camera option `{"viscaPtz": false}` turns it off). Presets are always stored over REST, so numbering matches `/recall`.
  - `visca`: generic VISCA-over-IP on UDP 52381 with Sony framing (or raw VISCA over UDP). Supports preset recall and store, absolute and relative pan/tilt, zoom, and position inquiry. For Sony BRC-X400 and similar cameras. Presets are 1-based in the UI and sent as `n-1`; you can change this with the `presetOffset` option.
  - `none`: a fixed camera.
  - Credentials are never stored in the database. A camera can reference a credential set by name, and the values are read from `SWITCHY_CRED_<REF>_USERNAME` and `SWITCHY_CRED_<REF>_PASSWORD`. On Kubernetes, inject them from a Secret.
- **Switching policy, per room:**
  - last-speaker or first-speaker mode;
  - optional chair priority;
  - 300 ms debounce;
  - when a speaker stops, the camera goes to the most recent remaining speaker;
  - when nobody is speaking, back to wide after a configurable delay;
  - a new speaker in the middle of a camera move cancels that move and restarts;
  - the same preset is never re-sent twice in a row;
  - a one-camera room either shows the move live or shows a holding NDI source while the camera moves.

**Stack.** TypeScript end to end:

- Node 22+ with Fastify.
- Drizzle ORM with PostgreSQL.
- Vite, React and official shadcn/ui components, served by the same process.
- **koffi** for the FFI into the NDI runtime. koffi ships prebuilt binaries, so there's no native compile step and no NDI headers are needed at build time.
- onnxruntime-node for the face and person models (CPU).

**Layout.**

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
docs/              deploy notes, roadmap
```

## Quick start

Requirements: Node 22+, Docker (for the development Postgres), and the NDI runtime (below) if you want program outputs.

```sh
git clone <this repo> switchy && cd switchy
npm ci && npm --prefix web ci
cp .env.example .env
docker compose up -d db          # Postgres on 127.0.0.1:55440
npm run models                   # optional: download the auto-framing/tracking models now
npm run build:web                # build the UI
npm run dev                      # API + engine + built UI on http://localhost:8090
# optional hot-reload UI: npm run dev:web  -> http://localhost:5180 (proxies /api)
```

Then open the UI, create a room, enter the DCen central unit's IP, add the cameras (driver, IP, NDI source name, role wide or PTZ) and map seats (DCen units) to presets.

Production build: `npm run build && npm start` (serves `dist/` and `web/dist/`). Container: see the `Dockerfile` and `docker compose --profile app up` (Linux hosts only, host networking).

Database migrations are in `drizzle/` and run automatically on startup. After changing `src/db/schema.ts`, run `npm run db:generate`.

Checks: `npm test`, `npm run typecheck`, `npm run build`. The parser and state-machine tests replay a recorded DCen session from `test/fixtures/`. Auto-framing tests use person-free room frames (`test/fixtures/autoframe/`). Frames with people stay out of the repo: put them in `test/fixtures/private/` (git-ignored) and run `npm run models`, and the real-detector tests run too.

## NDI runtime (required for program outputs)

The NDI SDK and runtime are proprietary and are **not** included in this repository. Switchy loads the runtime dynamically at startup, the same way DistroAV does. It uses its own minimal declarations of the public C functions it needs.

Install one of these:

- **Windows:** [NDI Tools](https://ndi.video/tools/), which includes the runtime, or the standalone NDI Runtime. The installer sets `NDI_RUNTIME_DIR_V6`, and Switchy finds `Processing.NDI.Lib.x64.dll` automatically.
- **Linux:** the [NDI SDK for Linux](https://ndi.video/for-developers/ndi-sdk/download/). Copy `lib/<arch>/libndi.so*` to `/usr/local/lib`, or point `NDI_RUNTIME_DIR` at the folder that contains it.
- **macOS:** the NDI SDK for Apple (`/Library/NDI SDK for Apple/lib/macOS`).

The download requires you to accept the NDI licence manually.

Search order:

1. `NDI_RUNTIME_DIR`
2. `NDI_RUNTIME_DIR_V6`
3. `NDI_RUNTIME_DIR_V5`
4. the standard install paths

Without a runtime, Switchy still runs and still moves the cameras, but it publishes no program output.

**Discovery across subnets.** NDI discovery uses mDNS, which doesn't cross routed subnets. Switchy therefore adds every configured camera IP to its NDI finder as an "extra IP" (`NDI_AUTO_EXTRA_IPS=true`, the default). You can add more with `NDI_EXTRA_IPS=a,b,c`. For a whole site, use an NDI Discovery Server, configured in `ndi-config.v1.json` with NDI Access Manager.

## Models

No model files are committed. They are downloaded and SHA-256-checked into `models/` (or `SWITCHY_MODELS_DIR`) at Docker build, by `npm run models`, or on first use. A download whose checksum does not match is rejected.

- Face: YuNet from [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (MIT).
- Head/upper-body fallback (tracking only): RTMDet-nano person and RTMPose-t body keypoints from [OpenMMLab](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose) (Apache-2.0).

Details, sizes and URL overrides are under Auto-framing below. For offline sites, download the files once and point the `SWITCHY_*_URL` variables at an internal mirror (the checksums are still enforced).

## Configuration

Rooms, cameras, seats and policies are configured in the web UI and stored in Postgres. The process itself is configured with environment variables (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Postgres connection string |
| `PORT` / `HOST` | `8090` / `0.0.0.0` | HTTP listener |
| `LOG_LEVEL` | `info` | `debug` logs every DCen line |
| `NDI_RUNTIME_DIR` | auto | folder containing the NDI runtime library |
| `NDI_EXTRA_IPS` | | extra NDI discovery targets (comma separated) |
| `NDI_AUTO_EXTRA_IPS` | `true` | add camera IPs to the NDI finder automatically |
| `NDI_GROUPS` | | NDI groups for finding sources and for the program outputs |
| `AUTH_MODE` | `off` | `off` or `proxy` (trust identity headers from an OIDC proxy); see `src/api/auth.ts` |
| `AUTH_ALLOWED_GROUPS` | | with `proxy`: require one of these groups |
| `SWITCHY_CRED_<REF>_USERNAME/_PASSWORD` | | camera credentials, referenced by name |
| `SWITCHY_MODELS_DIR` | `./models` | where the models are downloaded to |
| `SWITCHY_YUNET_URL` | OpenCV Zoo (pinned commit) | face model download URL (checksum still enforced) |
| `SWITCHY_RTMDET_URL`, `SWITCHY_RTMPOSE_URL` | OpenMMLab download server | head/body fallback model zips (checksums still enforced) |

## Saving seat presets from the browser

No NDI Studio Monitor needed (it can only store presets 1-9). Works on a phone.

No NDI Studio Monitor needed (it can only store presets 1-9). Works on a phone.

1. Open the room (live view) and turn **Automation** off, so a mic change doesn't move the camera while you aim.
2. On the PTZ camera card, tap **Aim & save**. A preview refreshes about once a second (an NDI frame grab from the camera's low-bandwidth stream, served as JPEG).
3. Hold the arrows to pan/tilt and **Zoom in / Zoom out** to zoom; release to stop. The slider sets the speed. The server stops the camera if the browser stops sending (deadman, 800 ms), so a dropped phone connection can't leave it moving.
4. Switch on the delegate's mic. The **Seat** field shows "Mic on: ...". Or pick any unit from the list.
5. Optionally change the preset number (default: preset = unit number) and the label, then tap **Save preset N for ...**.
   Switchy stores the camera's current position as that preset (BirdDog `/save`, VISCA memory set for Sony), maps the seat to it (without restarting the room), and stores a thumbnail.

Seat thumbnails (about 320x180 JPEG, 10-30 KB each) live in Postgres (`seat_thumbnails`), so the normal database backups cover them; there is no data directory to back up. They show in the live view's **Seats** card (tap to recall) and in the room editor. Upload one by hand with `PUT /api/rooms/<id>/seats/<unit>/thumbnail` (`content-type: image/jpeg`; it is resized).

API: `POST /api/rooms/:id/cameras/:cam/jog {pan,tilt,zoom: -1|0|1, speed: 1-100}`, `POST .../stop`, `GET .../position`, `GET .../snapshot.jpg?w=640`, `POST /api/rooms/:id/seats/save-preset {cameraId, unit?, preset?, label?}`, `PUT /api/rooms/:id/seats/:unit {cameraId, label?, preset?}`, `GET /api/rooms/:id/thumbnails`, `GET /api/rooms/:id/seats/:unit/thumbnail.jpg`.

## Auto-framing and tracking

### Auto-framing (optional, per room)

With **Auto-framing** on (room editor), Switchy adds a light touch-up between "PTZ recalled the seat preset" and "cut to PTZ". The presets are framed by hand; auto-framing only corrects for a person sitting slightly off their usual spot and never re-composes the shot:

1. wait until the PTZ's own low-bandwidth NDI picture is **still** (consecutive frames, phase correlation), so nothing is analysed while the preset move is running;
2. detect faces with **YuNet** on the CPU (onnxruntime-node, about 5-15 ms per frame) and pick the delegate: among faces at least 45% the size of the largest (people at the desks behind are ignored), the one whose eyes are nearest the target point (horizontal centre, upper third);
3. inside the deadband (default 8% of the width horizontally, 10% of the height vertically) cut straight away. If the face is further than the **largest correction** (default 15%) on either axis it is not the seated delegate slightly off (someone else, someone standing): no move, cut on the preset;
4. otherwise nudge: horizontally back to the centre, vertically only back just inside the band. Pan is a VISCA **relative** move. Tilt is a relative move only on cameras where it works (camera option `autoframe.relativeTilt: true`); the BirdDog P100 ignores positive and mis-scales negative relative tilt, so there tilt is an absolute move to the preset's **stored** coordinates plus the correction (skipped if the preset has none);
5. wait still, take a second picture to verify, allow one more small nudge if still outside the deadband (two passes at most), then cut.

The camera position is **never read** around a move: on the P100 those replies are stale (the previous preset's position) or garbage, and corrections built on them sent the camera far off in the first live test. Preset coordinates are recorded while the camera is idle: when a seat preset is saved from the UI (still picture, then three agreeing reads), or with `POST /api/rooms/:id/cameras/:cam/preset-positions {presets?}`, which recalls each preset and reads it while idle, only when the room is quiet (no mic on, nothing moving, camera not on program), and stops as soon as that changes. They are stored in `options.autoframe.presets`; the stored zoom also picks the calibration scale (fallback: `options.autoframe.referenceZoom`).

**Zoom** is off by default. With "Allow one small zoom step" on, a face clearly too small or too big (more than 1.6x off a typical 20% face height) gets one short relative zoom drive on the first pass (`autoframe.zoomStepMs`, default 200 ms at speed 2); absolute zoom is never changed.

The last picture (after the last nudge has settled) must pass the **shot gate** (see Active tracking): head fully in the frame with headroom, face size and eye line sane. Only then the program cuts to the PTZ. Otherwise (and on a timeout, default 4 s, or an error) `autoFrameFallback` decides: `preset-if-face` (default) shows the preset shot only if a face was at least seen with headroom, `wide` stays on wide for the turn, `preset` shows the preset anyway (the old behaviour). Plain preset mode (`refine` off) is unchanged. With "Save the refined position as the seat preset" on, the result is stored back into the seat's preset (off by default).

Earlier measurements (first version, one absolute move built on position reads), on a BirdDog P100 in the test room, with the NDI receiver warm: about 50-130 ms when no move is needed, and 0.65-0.9 s with a correction. That breaks down as frame grab under 10 ms, detection 4-15 ms, and two agreeing VISCA position reads of 80-130 ms (run alongside the grab and detection), then move plus settle of 570-860 ms. The first run after a server start adds about 0.2 s to load the model. Over 36 nudged trials, the camera's measured image shift matched the commanded one within about 3% for pan and about 10-15% for tilt. 30 trials ended inside the 5% deadband. Of the misses, three were the person moving or looking away, two were big tilt nudges that ended about 6% off (the tilt scale reads low), and one was a bad position read right after a restart.

**Calibration.** The correction needs to know how far the picture moves per VISCA pan/tilt unit, which depends on zoom. In the room editor, pause automation, aim the PTZ at a seat with some detail in the picture, and press **Calibrate**. No person is needed: the camera moves by known amounts at several zoom levels, the image shift is measured by phase correlation, and the result is stored in the camera's options (`options.autoframe.calibration`). This takes about a minute. API: `POST /api/rooms/:id/cameras/:cam/calibrate {zooms?}`; `POST .../autoframe {dryRun?}` runs one auto-frame on the current shot (also the **Auto-frame** button in the live view's "Aim & save" panel).

**Settling.** The P100 answers a VISCA position inquiry with its target, and sends the VISCA completion 75-250 ms after a small move, before the head has stopped (the picture is still only after about 0.5-0.6 s). Neither VISCA position polling nor the completion can tell when the camera has arrived. Switchy therefore waits until consecutive video frames stop moving (phase correlation, under 0.15 px at 320 wide).

**Models.** None are committed. They are downloaded and SHA-256-checked into `models/` (or `SWITCHY_MODELS_DIR`) at Docker build, by `npm run models`, or on first use.

- Face: `face_detection_yunet_2026may.onnx` from [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (MIT, Copyright (c) 2020 Shiqi Yu, about 230 KB; the 2023mar weights re-exported with dynamic input size). URL override: `SWITCHY_YUNET_URL`.
- Head/upper-body fallback (tracking only): [RTMDet-nano person](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose) (320x320, 4 MB) and RTMPose-t body keypoints (256x192, 13 MB), OpenMMLab, Apache-2.0, from the official mmdeploy ONNX SDK zips (the zip and the extracted `.onnx` are both checksummed). URL overrides: `SWITCHY_RTMDET_URL`, `SWITCHY_RTMPOSE_URL`. RTMPose "body7" weights were trained on public pose datasets (COCO, AI Challenger, CrowdPose, MPII, sub-JHMDB, Halpe, PoseTrack18), some of which carry research-use terms for the data itself; the released weights are Apache-2.0. Ultralytics YOLO (AGPL-3.0, compatible with this project) was not needed.

InsightFace/SCRFD weights are deliberately not used: their licence is non-commercial.

### Active tracking (optional, per room)

Room editor, Auto-framing, **Mode: Track the speaker** (`policy.refine = 'track'`). While a delegate's mic is the active shot, the PTZ keeps them framed with slow VISCA pan/tilt **velocity drive** (the same commands as the hold-to-move jog), like a calm operator:

1. mic on: program to wide, recall the seat preset, wait the settle time and until the picture is still;
2. **acquire** the delegate: the face nearest the frame centre / upper third (faces under 45% of the largest are ignored, and a face more than 30% off is not taken), seen in two consecutive frames;
3. **shot gate** (two-camera rooms): the program shows the PTZ **only while the shot is good**, otherwise the wide camera (see below). There is no "cut anyway" on a timeout any more: a shot that never becomes good keeps the program on wide for the whole turn (after `refineTimeoutMs` the log says why). Tracking continues while on air and while on wide;
4. on a speaker change, pause, manual take, manual preset recall, jog or preset save, tracking stops with an explicit stop command before anything else is sent to the camera, and the normal cover-and-recall follows.

The loop (`src/engine/autoframe/tracker.ts`, maths in `track-controller.ts`) runs at about 10 Hz on the low-bandwidth NDI frames: YuNet on the full 640x360 frame (about 6 ms) plus a phase correlation at 320 wide that measures how far the camera itself moved the picture (about 9 ms). When YuNet has no usable face in the seat region (turned head, looking up, hand on the face), the head/upper-body fallback runs on that tick too (RTMDet-nano person boxes + RTMPose-t keypoints, about 15-25 ms on an i7-12700): a YuNet-like head box is derived from the nose, eyes, ears and shoulders (`src/engine/autoframe/person.ts`). On the round-2 recordings a tick took 15 ms median, 35 ms p95, 49 ms max (budget 125 ms for 8 Hz). Without any face keypoint only the top of the person box is used, for continuity, never for a good shot. Switch: `trackFallbackDetector` (on).

**Shot gate** (`src/engine/autoframe/shot-gate.ts`). A shot is good when all hold: target locked; head fully in the frame (top of the head = face box top - 0.3 face heights, at least `trackHeadroomPct` = 5% below the top edge); the face not cut at the sides or the bottom (2% margin); face height 8-35% of the frame; eye line within 15% of the upper third; camera not moving fast (image speed up to 0.2 frame/s, slow tracking moves are fine). Staying on the PTZ uses looser thresholds than cutting to it (headroom -2%, eye line +5%, size band +/-15%, speed x1.6).

**Sharpness** (`src/engine/autoframe/sharpness.ts`). On every matched tick the tracker measures the Laplacian variance of the head region (face box plus the top of the head) on the low-bandwidth frame, smoothed over 3 ticks. Each seat keeps a recent sharp baseline in memory (75th percentile of up to 120 values measured while the shot was good and the camera still; needs 20). The gate does not **cut to** the PTZ while the head is below `trackBlurRatioPct` (30%) of that baseline (motion blur right after a move or of a moving head, focus hunting); it never takes the PTZ off program for it. The log says `shot gate: head blurry (sharpness 20% of this seat's usual); not cutting to the PTZ while the head is blurry`. A seat that stays soft for 8 s is let through for that turn (a stale baseline must not keep a seat off air). On the round-3 recordings (2 Hz), 29 of 696 good frames were under 30% of their seat's baseline, nearly all of them visibly motion-blurred heads.

| setting | default | |
| --- | --- | --- |
| `trackHoldBeforeCutMs` | 400 | the shot must be good this long before the cut to the PTZ |
| `trackLostToWideMs` | 700 | target lost this long while on the PTZ: wide (also inside the dwell) |
| `trackBadToWideMs` | 700 | shot bad this long while on the PTZ (e.g. stood up): wide |
| `trackMinDwellMs` | 2000 | at least this long on each source between gate cuts |
| `trackHeadroomPct` | 5 | headroom above the head, % of the frame height |
| `trackBlurRatioPct` | 30 | no cut to the PTZ while the head is softer than this % of the seat's usual sharpness (0 = off) |

Every gate cut is logged with its reason, e.g. `program -> X1 Ultra wide "..." (target lost 712 ms)` or `program -> P100 PTZ "..." (seat Seat 6; shot good: headroom 9%, face 22%)`. The live view shows a "shot: good / bad / lost / searching" badge with the reason and whether the program is on the PTZ or on wide. One-camera rooms (no wide camera to fall back on) keep the old cut-when-framed behaviour.

**Acquisition.** Inside the seat region (the preset aim +/- 30%) a face down to `trackSeatMinScore` (0.5) is enough to acquire or re-acquire; elsewhere 0.6 as before. Round 2 showed that most of the slow first locks were not detector misses: after a preset recall the P100 keeps answering the pan/tilt position inquiry with the position from **before** the recall (zoom is current) for many seconds, so the start check recalled the preset three times (about 3.4 s each) before tracking could start. Pan/tilt reads are now only trusted after a recall once they agree with the preset or have changed after a drive; until then the estimate is the stored preset position plus dead reckoning, and only a zoom far off recalls. Garbage replies (pan equal to the zoom value, tilt out of range) are ignored.

- **Identity lock.** Constant-velocity Kalman filters on the target's eye point and face height, kept in "world" coordinates (the camera's own measured motion removed). Detections are associated ByteTrack-style: high-confidence first by IoU with the predicted box plus a distance gate (in face heights) and a size-ratio gate; low-confidence detections (score 0.35-0.6) only keep a live track going. Nothing outside the gate is ever adopted, so it never jumps to another person.
- **Loss.** No match for 250 ms: stop. After `trackLossTimeoutMs` (1.5 s): "holding". Optionally back to the seat preset and re-acquire after `trackReturnAfterMs` (0 = never). Detection keeps running on every tick while lost or holding; with `trackReacquire` (on by default) a confident face of plausible size near the last known position or near the preset aim is picked up again without the strict identity gate (log: "reacquired after N ms"). A face outside the seat region (the preset aim +/- the excursion limit) is never taken, so it cannot jump to a neighbour.
- **Calm movement.** Deadzone with hysteresis (start outside 10% horizontally / 12% vertically, stop inside 40% of that or on overshoot); eyes on the upper third. PD on a Smith-predicted error: measured error, plus the correction still in flight from the commands of the last 0.3 s (P100: picture starts moving 185-260 ms and stops 230-440 ms after a drive command), plus the target's own motion over that time; gain kp = 0.85/s (kp x latency about 0.25). The desired speed is mapped onto the camera's speed levels through a measured table (P100 pan level 1 barely moves, tilt 2 is slower than tilt 1; both skipped) and a per-axis scale learnt online from the measured motion (the P100's speed per level changes with zoom); the level is slew-limited up and down and capped at `trackMaxSpeed` (default 5, about a quarter of the frame per second; up to +2 before the cut).
- **Headroom beats the eye-line deadzone.** With a big face the eyes can sit inside the 12% vertical deadzone while the top of the head is already at the edge (round 3, seat 10: the program flipped wide/PTZ with "head cut off at the top"). The tracker predicts the headroom (eye line minus eye-to-head-top, measured on the matched boxes) and tilts up as soon as it falls below the gate's stay threshold + 2% (5% by default), even inside the deadzone, and stops at the cut threshold + 5% (10%), never pushing the eyes more than the inner band below the eye line. Too much headroom keeps the tolerant deadzone. In the simulator replay of the seat-10 case (face 29%, eyes leaning 7-11% above the eye line) the gate cut 12 times in 40 s without the rule and once with it.
- **Learned seat correction** (`trackLearn`, on; `src/engine/autoframe/learn.ts`). After a good turn (shot gate good for at least 5 s in total; locked at the end; ended by a speaker change, not by a loss, a pause or manual control; no hard-rule recall; offset steady, i.e. its spread (interquartile range) per axis over the still, good ticks at most `trackLearnMaxSpreadPct`, 8%)  the median offset of the delegate from the preset aim over the still, good ticks is stored for the seat: the tracker's world eye position (accumulated camera motion measured from the picture plus the remaining image offset), converted to VISCA pan/tilt units with the calibration at the preset's stored zoom. P100 position reads are not used for it. The last `trackLearnSamples` (5) per seat live in Postgres (`seat_corrections`, covered by the DB backup). From 2 samples on, the median (capped at `trackLearnCapPct`, default 10% of the frame per axis) is applied on the next turn: recall the hand-saved preset (never overwritten), wait for a still picture, one move (relative pan; with a tilt part an absolute move to the preset's stored coordinates plus the correction, as the P100's relative tilt is broken), then tracking starts; the seat region and excursion limits stay relative to the preset. A large offset alone is not a reason to reject a turn (a preset that is 20% off for whoever sits there is what learning fixes); only ticks with the person further than `trackLearnMaxOffsetPct` (35%, the default excursion limit) from the preset aim are ignored as probably the wrong person. A finished turn that is not learned logs one line with the reason, e.g. `seat 6 turn not learned: offset not steady: spread (IQR) x 12.0% y 1.0% > 8% over 40 frames (...)`. Log lines: `learned correction for seat N: +3.0% x, -2.0% y (pan +9, tilt +4; 4 turns)` when it changes and `...; applied after the recall` when used. The room editor lists each seat's correction with **Reset seat** and **Reset all**; saving a seat preset again clears that seat. API: `GET /api/rooms/:id/learned`, `DELETE /api/rooms/:id/learned/:unit`, `DELETE /api/rooms/:id/learned`.
- **Safety.** A watchdog stops the camera if the loop stalls for 600 ms while moving. The camera never goes further than `trackMaxExcursionPct` (default 35% of the frame) from the preset, measured from the camera's own image motion, so it cannot drift to the next seat. Tracking never runs while the room is paused.
- **Zoom** (`trackZoom`, off by default): small absolute zoom steps (never a free-running zoom drive), only while pan/tilt are idle, to keep the face height between 14% and 30%; always inside the seat preset's stored zoom +/- `trackZoomTolerancePct` (15%).
- **Hard rules (camera units).** In track and auto-frame mode every speaker turn recalls the seat preset (the "same preset again" shortcut is kept only for plain presets on a camera nothing moved). When the picture is still the session reads the idle VISCA position: zoom more than the tolerance off the preset's stored zoom, or pan/tilt far beyond the limit, means the recall did not take or something else moved the camera: explicit stop, recall, re-acquire. The excursion limit is also enforced in VISCA units (dead-reckoned from the commanded speed levels while moving, re-read while idle), so it holds even when the image estimate is wrong. A face taller than `trackTightFacePct` (35%) recalls the preset. No face for 6 s after the start: the position is checked and the preset recalled if it is off. At most 3 recalls per session.
- **Stops.** Every stop is pan/tilt *and* zoom, each retried once. Every PTZ gets an explicit stop at room start (a drive left by a killed process ends there), on room restart/stop and on server shutdown. An idle sanity check (every 20 s; PTZ idle, not on program, no manual control for 2 min) recalls the last preset when the camera sits far from every stored preset.
- **Logging.** The event log gets summary lines only: started, acquired, framed, lost, holding, excursion limit, gate cuts, and one line at the end (ticks and rate, per-tick grab/detect/motion times, % locked, moves, reversals, max excursion, learnt speed scale, fallback ticks and time). The live view shows a "tracking: searching / locked / lost / holding" badge and the shot-gate badge.

Per-camera overrides (rarely needed) in `options.autoframe.track`: `ratesPan`/`ratesTilt` (image speed per level, frame fractions per second), `kp`, `kd`, `tau`, `innerRatio`, `coastMs`, `slewUp`, `slewDown`.

Test hook (room quiet: no mic on, automation running, PTZ not on program): `POST /api/rooms/:id/cameras/:cam/track {durationMs}` tracks on the camera's current shot and answers with the log lines; `{action:"stop"}` stops it. Any mic, pause or manual control stops it as well.

## Limitations

- **Cut-only output.** NDI routing re-points receivers at a camera, so there are no transitions and receivers show a short hitch at each cut. Receivers need a network path to every camera, not just to Switchy.
- **One microphone system.** Only the Brähler DCen is supported as a source of microphone events. After a reconnect Switchy assumes all mics are off.
- **Sony VISCA untested.** The `visca` driver follows the Sony VISCA-over-IP framing but has not been run against a real BRC-X400.
- **Tracking tuned on one camera.** Speed tables and quirks (stale position replies, broken relative tilt) were measured on the BirdDog P100.
- **Single process.** Engine, API and UI run in one process, one instance per site. The event log is an in-memory ring (300 entries per room).
- **Containers need host networking** for NDI discovery (or an NDI Discovery Server); Docker host networking only works on Linux.
- **Auth** is either off or delegated to a reverse proxy; there is no built-in login.

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md). Highlights:

- a "switcher" output mode (receive, decode, mix with real transitions, re-encode) behind the `ProgramOutput` interface;
- using the video-still detector instead of a fixed settle time after preset recalls;
- a "measure drive speeds" button so other PTZ models plug into tracking;
- splitting the engine into its own process, native OIDC, a persisted event log.

Deployment notes (containers, Kubernetes, NDI across subnets): [`docs/deploy.md`](docs/deploy.md).

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).

## License

Copyright (C) 2026 the Switchy contributors.

Switchy is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3 only, as published by the Free Software Foundation. See [`LICENSE`](LICENSE). If you run a modified version as a network service, the AGPL requires you to offer its source to the users of that service.

Third-party models are downloaded at run time under their own licences (MIT, Apache-2.0); see Models.

## Trademarks

NDI® is a registered trademark of Vizrt NDI AB. Switchy is an independent project. Vizrt NDI AB does not endorse or sponsor it, and it is not affiliated with Vizrt NDI AB.

Brähler and DCen are trademarks of their respective owners; this project is not affiliated with or endorsed by them. BirdDog, Sony, BRC and VISCA are trademarks of their respective owners; this project is not affiliated with or endorsed by them. They are named only to describe compatibility.
