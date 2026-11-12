# Switchy

[![CI](https://github.com/alee-ibrahim/switchy/actions/workflows/ci.yml/badge.svg)](https://github.com/alee-ibrahim/switchy/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![Last commit](https://img.shields.io/github/last-commit/alee-ibrahim/switchy)](https://github.com/alee-ibrahim/switchy/commits/main)

Automatic, microphone-triggered camera switching for conference and committee rooms. When a delegate switches on their mic on a **Brähler DCen** system, Switchy cuts to the wide shot, sends the PTZ camera to that seat's preset, optionally frames or tracks the speaker, and cuts to the PTZ, all on a per-room **NDI®** program output that recorders and streamers subscribe to. No OBS, no hardware switcher. Early software (v0.1), already in daily use in a parliament committee room.

## Features

- **Mic-triggered switching** from Brähler DCen events, read-only, with a per-room policy (last/first speaker, chair priority, back to wide).
- **NDI program output per room** via NDI routing: no video passes through the server.
- **PTZ control** over BirdDog REST and VISCA-over-IP, with seat presets aimed and saved from the browser (works on a phone).
- **Auto-framing and active tracking** (optional): CPU face/person detection, a shot-quality gate and learned per-seat corrections.
- **Web UI** (React + shadcn/ui) with a live view and event log; proxy auth for running behind OIDC.

## Supported hardware

| Device | Status |
| --- | --- |
| Brähler DCen central unit | tested |
| BirdDog X1 / X1 Ultra, P100 | tested |
| Sony BRC-X400 and other VISCA-over-IP PTZs | implemented, untested |
| Any NDI camera or source (wide / holding) | tested |

Details in [docs/hardware.md](docs/hardware.md).

## Quick start

Needs Node 22+, Docker (for the dev Postgres) and, for program outputs, the [NDI runtime](docs/hardware.md#ndi-runtime-required-for-program-outputs).

```sh
git clone https://github.com/alee-ibrahim/switchy.git && cd switchy
npm ci && npm --prefix web ci
cp .env.example .env
docker compose up -d db          # Postgres on 127.0.0.1:55440
npm run models                   # optional: auto-framing/tracking models
npm run build:web && npm run dev # http://localhost:8090
```

Then create a room in the UI, add the DCen and cameras, and map seats to presets ([docs/configuration.md](docs/configuration.md)).

## Documentation

[Architecture](docs/architecture.md) · [Hardware](docs/hardware.md) · [Configuration](docs/configuration.md) · [Tracking](docs/tracking.md) · [Deploy](docs/deploy.md) · [Roadmap](docs/roadmap.md) · [All docs](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Licence and trademarks

Copyright (C) 2026 the Switchy contributors. [AGPL-3.0-only](LICENSE): if you run a modified version as a network service, offer its source to its users. Models are downloaded at run time under their own licences (MIT, Apache-2.0; see [docs/tracking.md](docs/tracking.md#models)).

NDI® is a registered trademark of Vizrt NDI AB; Brähler, DCen, BirdDog, Sony, BRC and VISCA are trademarks of their respective owners. Switchy is independent and not affiliated with or endorsed by any of them.
