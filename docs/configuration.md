# Configuration

Rooms, cameras, seats and policies are configured in the web UI and stored in Postgres. The process itself is configured with environment variables.

## Environment variables

See also `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Postgres connection string |
| `PORT` / `HOST` | `8090` / `0.0.0.0` | HTTP listener |
| `LOG_LEVEL` | `info` | `debug` logs every DCen line |
| `NDI_RUNTIME_DIR` | auto | folder containing the NDI runtime library |
| `NDI_EXTRA_IPS` | | extra NDI discovery targets (comma separated) |
| `NDI_AUTO_EXTRA_IPS` | `true` | add camera IPs to the NDI finder automatically |
| `NDI_GROUPS` | | NDI groups for finding sources and for the program outputs |
| `AUTH_MODE` | `off` | `off` or `proxy` (trust identity headers from an OIDC proxy); see `src/api/auth.ts` and [deploy.md](deploy.md#auth) |
| `AUTH_ALLOWED_GROUPS` | | with `proxy`: require one of these groups |
| `SWITCHY_CRED_<REF>_USERNAME/_PASSWORD` | | camera credentials, referenced by name |
| `SWITCHY_MODELS_DIR` | `./models` | where the models are downloaded to |
| `SWITCHY_YUNET_URL` | OpenCV Zoo (pinned commit) | face model download URL (checksum still enforced) |
| `SWITCHY_RTMDET_URL`, `SWITCHY_RTMPOSE_URL` | OpenMMLab download server | head/body fallback model zips (checksums still enforced) |

## Room setup

Open the UI, create a room, enter the DCen central unit's IP, add the cameras (driver, IP, NDI source name, role wide or PTZ) and map seats (DCen units) to presets.

Per-room settings in the room editor:

- **Switching policy:** last- or first-speaker, chair priority, back-to-wide delay, one-camera behaviour (live move or holding source). See [architecture.md](architecture.md#building-blocks).
- **Auto-framing / tracking:** mode (off, auto-frame, track the speaker), fallback, shot-gate and learning settings. See [tracking.md](tracking.md).
- **Camera options** (JSON, per camera): e.g. `viscaPtz`, `presetOffset` ([hardware.md](hardware.md#cameras)) and `autoframe.*` ([tracking.md](tracking.md)).

## Saving seat presets from the browser

No NDI Studio Monitor needed (it can only store presets 1-9). Works on a phone.

1. Open the room (live view) and turn **Automation** off, so a mic change doesn't move the camera while you aim.
2. On the PTZ camera card, tap **Aim & save**. A preview refreshes about once a second (an NDI frame grab from the camera's low-bandwidth stream, served as JPEG).
3. Hold the arrows to pan/tilt and **Zoom in / Zoom out** to zoom; release to stop. The slider sets the speed. The server stops the camera if the browser stops sending (deadman, 800 ms), so a dropped phone connection can't leave it moving.
4. Switch on the delegate's mic. The **Seat** field shows "Mic on: ...". Or pick any unit from the list.
5. Optionally change the preset number (default: preset = unit number) and the label, then tap **Save preset N for ...**.
   Switchy stores the camera's current position as that preset (BirdDog `/save`, VISCA memory set for Sony), maps the seat to it (without restarting the room), and stores a thumbnail.

Seat thumbnails (about 320x180 JPEG, 10-30 KB each) live in Postgres (`seat_thumbnails`), so the normal database backups cover them; there is no data directory to back up. They show in the live view's **Seats** card (tap to recall) and in the room editor. Upload one by hand with `PUT /api/rooms/<id>/seats/<unit>/thumbnail` (`content-type: image/jpeg`; it is resized).

API: `POST /api/rooms/:id/cameras/:cam/jog {pan,tilt,zoom: -1|0|1, speed: 1-100}`, `POST .../stop`, `GET .../position`, `GET .../snapshot.jpg?w=640`, `POST /api/rooms/:id/seats/save-preset {cameraId, unit?, preset?, label?}`, `PUT /api/rooms/:id/seats/:unit {cameraId, label?, preset?}`, `GET /api/rooms/:id/thumbnails`, `GET /api/rooms/:id/seats/:unit/thumbnail.jpg`.
