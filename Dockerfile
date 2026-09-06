# Playwright base ships Chromium + system deps (browsers live in /ms-playwright).
# We add Bun and our MCP server on top. Headless Chromium only in Docker.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Bun via the official image (pinned for reproducibility; avoids installer
# download flakiness — a broken curl|bash pipe can silently "succeed")
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version

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
ENV PORT="3123"

RUN mkdir -p /app/.browser-use

EXPOSE 3123

# Streamable HTTP transport (MCP at /mcp) so any local VS Code instance
# can reach the server over http://localhost:3123/mcp
ENTRYPOINT ["bun", "src/http.ts"]
