# Playwright base ships Chromium + system deps (browsers live in /ms-playwright).
# We add Bun and our MCP server on top. Headless Chromium only in Docker.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Install Bun (playwright image is Ubuntu noble; curl/unzip needed for installer)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash

ENV BUN_INSTALL="/root/.bun"
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Install deps first for better layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json .env.example ./
COPY src ./src
COPY skills ./skills

# Server defaults inside the container (override via compose/env at runtime)
ENV BROWSER_HEADLESS="true"
ENV OUTPUT_DIR="/app/.browser-use"
ENV PORT="3000"

RUN mkdir -p /app/.browser-use

EXPOSE 3000

# Streamable HTTP transport (MCP at /mcp) so any local VS Code instance
# can reach the server over http://localhost:3000/mcp
ENTRYPOINT ["bun", "src/http.ts"]
