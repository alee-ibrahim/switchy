# Deployment notes

Switchy has so far been run as a single process on a Windows PC in the AV network. These notes cover running it in a container or on Kubernetes.

## Pieces

| Piece | Network needs | Kubernetes shape |
| --- | --- | --- |
| Engine: DCen clients, camera control, NDI finder and routers | Must reach the AV network: TCP 3225 to the DCen units, HTTP 8080 and UDP 52381 to the cameras, NDI (TCP 5960+, mDNS) | `hostNetwork: true` on a node with an interface in the AV network, **or** a normal pod plus an NDI Discovery Server |
| UI and API | Plain HTTP | Normal Deployment, Service and Ingress/HTTPRoute |
| DB | | Any PostgreSQL (e.g. a CloudNativePG `Cluster`) |

In this version the engine and the UI/API are **one process**. The engine is a self-contained module (`src/engine/`, no HTTP or DB imports), so it can be split out later:

- an `engine` process that reads room configs from the DB (or from the API) and exposes snapshots and events over a small internal API or NOTIFY;
- the UI/API that proxies the manual actions.

## NDI in containers

- **mDNS does not cross pod or container networks.** A routed NDI source that is announced from inside a pod network is invisible to the AV network unless one of these is true:
  1. the container runs with host networking (`hostNetwork: true` on Kubernetes) on a host that has an interface in the AV network. This is simplest, and the routed output is then announced as `<host name> (Switchy (Room X Program))`;
  2. or the site uses an **NDI Discovery Server**. Both Switchy (`ndi-config.v1.json` → `networks.discovery`, mounted via `NDI_CONFIG_DIR`) and all receivers must be configured for it. Pod IPs must also be reachable from the receivers for the actual NDI TCP connection, so this usually still means host networking or a routable pod IP.
- **Routed subnets.** In testing, mDNS did not find cameras on a different routed subnet from the Switchy host, but unicast "extra IPs" did. Switchy adds every camera IP automatically (`NDI_AUTO_EXTRA_IPS`). Receivers on other subnets need the same treatment to *see* the routed program output: an extra IP of the Switchy host in their NDI Access Manager, or a Discovery Server.
- **Routing redirects receivers to the camera.** After a cut, each receiver pulls video *directly from the camera*. Receivers therefore need a network path to every camera, not just to Switchy.
- **Runtime.** Bake the Linux runtime into your own image with `--build-arg INSTALL_NDI_RUNTIME=true --build-arg ACCEPT_NDI_LICENSE=yes` (see the Dockerfile notes on the NDI licence), and push it only to a private registry. Do not publish an image that contains the NDI runtime unless the NDI licence allows your distribution.
- **CPU support.** Check that libndi runs on the chosen host. `NDIlib_initialize()` returns false on unsupported CPUs (for example some CPUs without AVX), and Switchy logs this.

## Database

- PostgreSQL 15 or later. Migrations run on startup (`drizzle/`). For multiple replicas, move them to an init Job.
- Room configs, seat thumbnails and learned seat corrections all live in the database, so a normal database backup covers everything. Set up backups from day one.

## Secrets

- `DATABASE_URL` and camera credentials (`SWITCHY_CRED_<REF>_*`) come from the environment. On Kubernetes, inject them from a Secret (managed by your usual secrets tooling).

## Auth

- `AUTH_MODE=proxy` behind an authenticating reverse proxy (OIDC via oauth2-proxy, a gateway security policy, ...). The proxy forwards identity headers (`x-auth-request-email`, groups).
- Set `AUTH_ALLOWED_GROUPS` to your AV operators group.
- Make sure the proxy strips any client-supplied identity headers.
- `/api/health` stays unauthenticated for probes.
- A native OIDC mode can be added in `src/api/auth.ts` later.

## Probes

- liveness and readiness: `GET /api/health`.
- SSE (`/api/events`) needs no buffering at the proxy. The app sends `x-accel-buffering: no` and pings every 15 s.
