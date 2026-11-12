# Switchy container image.
#
# NDI(R) runtime: NOT included by default. The NDI SDK is proprietary
# (NDI SDK License Agreement, https://ndi.video/). To bake the Linux runtime
# into YOUR image, build with
#   docker build --build-arg INSTALL_NDI_RUNTIME=true --build-arg ACCEPT_NDI_LICENSE=yes .
# which downloads the official NDI SDK for Linux at build time and copies only
# libndi.so* into the image. By doing so you accept the NDI SDK licence. Do not
# publish such an image unless the NDI licence allows your distribution.
# Alternatively mount a runtime and set NDI_RUNTIME_DIR.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY . .
RUN npm run build && npm prune --omit=dev
# models for auto-framing (OpenCV Zoo YuNet, MIT; OpenMMLab RTMDet-nano person +
# RTMPose-t keypoints, Apache-2.0; all sha256-checked) and only
# this platform's onnxruntime binaries (the npm package ships all of them)
RUN SWITCHY_MODELS_DIR=/app/models node dist/engine/autoframe/fetch-model.js && \
    cd node_modules/onnxruntime-node/bin/napi-v6 && rm -rf win32 darwin && \
    arch="$(node -p process.arch)" && find linux -mindepth 1 -maxdepth 1 ! -name "$arch" -exec rm -rf {} +

FROM node:22-bookworm-slim AS ndi
ARG INSTALL_NDI_RUNTIME=false
ARG ACCEPT_NDI_LICENSE=no
ARG NDI_SDK_URL=https://downloads.ndi.tv/SDK/NDI_SDK_Linux/Install_NDI_SDK_v6_Linux.tar.gz
RUN mkdir -p /ndi/lib && if [ "$INSTALL_NDI_RUNTIME" = "true" ]; then \
      [ "$ACCEPT_NDI_LICENSE" = "yes" ] || { echo "Set ACCEPT_NDI_LICENSE=yes to accept the NDI SDK licence"; exit 1; }; \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
      cd /tmp && curl -fsSL "$NDI_SDK_URL" -o ndi.tar.gz && tar -xzf ndi.tar.gz && \
      yes | PAGER=cat sh ./Install_NDI_SDK_v6_Linux.sh > /dev/null && \
      arch="$(uname -m)-linux-gnu" && \
      cp -P "/tmp/NDI SDK for Linux/lib/${arch}/"libndi.so* /ndi/lib/ && \
      cp "/tmp/NDI SDK for Linux/licenses/"* /ndi/ 2>/dev/null || true; \
    fi

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8090 NDI_RUNTIME_DIR=/opt/ndi/lib SWITCHY_MODELS_DIR=/app/models
# avahi client lets libndi use the host's mDNS daemon when present (hostNetwork)
RUN apt-get update && apt-get install -y --no-install-recommends libavahi-client3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/models ./models
COPY --from=build /app/package.json ./
COPY --from=ndi /ndi /opt/ndi
USER node
EXPOSE 8090
CMD ["node", "dist/server.js"]
