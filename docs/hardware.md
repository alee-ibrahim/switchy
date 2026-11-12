# Hardware

| Device | How | Status |
| --- | --- | --- |
| Brähler DCen central unit | read-only TCP, port 3225, ASCII status lines | tested |
| BirdDog X1 / X1 Ultra, P100 | REST on :8080 (presets) + VISCA-over-IP on UDP 52381 (jog, zoom, position, tracking) | tested |
| Sony BRC-X400 and similar | VISCA-over-IP (Sony framing) on UDP 52381 | implemented, **untested** on real hardware |
| Any NDI camera or source | as a fixed (wide) camera or a holding source | tested |

Other VISCA-over-IP PTZ cameras will probably work with the `visca` driver. Tracking speeds and quirks were measured on the BirdDog P100; other cameras may need tuning (see the per-camera overrides in [tracking.md](tracking.md#active-tracking-optional-per-room)).

## Brähler DCen

Switchy makes a read-only TCP connection to the DCen central unit (port 3225, ASCII). The central unit sends plain-text status lines on this port of its network interface during normal operation; Switchy parses `MIC-ON`, `MIC-OFF` and `READY` from them and never sends anything to the DCen. See `src/engine/dcen/`.

- `MIC-OFF;FFFF;FFFF;` ("all off") is honoured **only in the connect status dump**, i.e. before `READY;` (or within 5 s of connecting if `READY;` never comes). The DCen also sends it at random times while a mic is still on; after `READY;` it is logged as a warning and ignored.
- After a reconnect Switchy assumes all mics are off.

## Cameras

Camera control goes through a driver interface (`src/engine/cameras/types.ts`):

- `birddog`: BirdDog REST on :8080: `POST /recall` and `POST /save` with `{"Preset":"Preset-N"}` (save answers `{"Save-Preset":"N"}`; presets above 9 work). Tested with the X1 Ultra and P100. Jog, zoom and position use VISCA-over-IP on UDP 52381 (on by default; camera option `{"viscaPtz": false}` turns it off). Presets are always stored over REST, so numbering matches `/recall`.
- `visca`: generic VISCA-over-IP on UDP 52381 with Sony framing (or raw VISCA over UDP). Supports preset recall and store, absolute and relative pan/tilt, zoom, and position inquiry. For Sony BRC-X400 and similar cameras. Presets are 1-based in the UI and sent as `n-1`; you can change this with the `presetOffset` option.
- `none`: a fixed camera.
- Credentials are never stored in the database. A camera can reference a credential set by name, and the values are read from `SWITCHY_CRED_<REF>_USERNAME` and `SWITCHY_CRED_<REF>_PASSWORD`. On Kubernetes, inject them from a Secret.

New camera drivers implement the interface in `src/engine/cameras/types.ts` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## NDI runtime (required for program outputs)

The NDI SDK and runtime are proprietary and are **not** included in this repository. Switchy loads the runtime dynamically at startup, the same way DistroAV does. It uses its own minimal declarations of the public C functions it needs.

Install one of these:

- **Windows:** [NDI Tools](https://ndi.video/tools/), which includes the runtime, or the standalone NDI Runtime. The installer sets `NDI_RUNTIME_DIR_V6`, and Switchy finds `Processing.NDI.Lib.x64.dll` automatically.
- **Linux:** the [NDI SDK for Linux](https://ndi.video/for-developers/ndi-sdk/download/). Copy `lib/<arch>/libndi.so*` to `/usr/local/lib`, or point `NDI_RUNTIME_DIR` at the folder that contains it.
- **macOS:** the NDI SDK for Apple (`/Library/NDI SDK for Apple/lib/macOS`).
- **Containers:** see [deploy.md](deploy.md#ndi-in-containers) and the notes at the top of the `Dockerfile`.

The download requires you to accept the NDI licence manually.

Search order:

1. `NDI_RUNTIME_DIR`
2. `NDI_RUNTIME_DIR_V6`
3. `NDI_RUNTIME_DIR_V5`
4. the standard install paths

Without a runtime, Switchy still runs and still moves the cameras, but it publishes no program output.

**Discovery across subnets.** NDI discovery uses mDNS, which doesn't cross routed subnets. Switchy therefore adds every configured camera IP to its NDI finder as an "extra IP" (`NDI_AUTO_EXTRA_IPS=true`, the default). You can add more with `NDI_EXTRA_IPS=a,b,c`. For a whole site, use an NDI Discovery Server, configured in `ndi-config.v1.json` with NDI Access Manager.
