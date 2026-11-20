# effing-use-mobile — MCP server for Android/Capacitor WebView control.
#
# The image needs an adb binary, not a Chromium: the app under test supplies the
# renderer. Debian slim keeps the image small and `android-sdk-platform-tools`
# gives a current adb, which Alpine's android-tools does not reliably do.
FROM oven/bun:1-slim AS deps

WORKDIR /app
COPY package.json bun.lock ./
# Production deps only: the server has no devDependency at runtime.
RUN bun install --production --frozen-lockfile

FROM oven/bun:1-slim

# adb is the transport to the device. Debian ships it as its own `adb` package
# (android-sdk-platform-tools alone does not include the binary).
RUN apt-get update \
  && apt-get install -y --no-install-recommends adb ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && adb version

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY skills ./skills

# Artifacts and the session journal must survive the container, so they live in
# a volume rather than the image layer.
ENV MOBILE_OUTPUT_DIR=/data \
    MOBILE_JOURNAL=1 \
    NODE_ENV=production

VOLUME ["/data"]

# stdio transport: the client runs `docker run -i`, so nothing is published.
# Absolute path on purpose: compose sets working_dir to the mounted Capacitor
# project, and a relative `src/index.ts` would then resolve to *that* repo's
# src/index.ts — which is how the browser server once answered instead.
ENTRYPOINT ["bun", "/app/src/index.ts"]
