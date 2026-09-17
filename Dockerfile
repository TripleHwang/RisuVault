# ------------------------------------------------------------------------------------------

FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Copy dependency-related file
COPY package.json .
COPY pnpm-lock.yaml .

RUN corepack enable
RUN corepack install --global pnpm@10.34.1

# ------------------------------------------------------------------------------------------

FROM base AS deps
# dist/ is prebuilt in the builder stage, so the runtime image only needs the
# server's runtime dependency closure (~46MB) — not the full prod
# node_modules (~750MB). The dependency list and its lockfile are committed at
# scripts/portable/server-deps/; regenerating verifies the committed list still
# matches what the server actually requires, and the frozen install keeps
# transitive versions reproducible.
COPY pnpm-workspace.yaml .
COPY server ./server
COPY packages/risubard-core ./packages/risubard-core
COPY src/ts/risubard ./src/ts/risubard
COPY scripts/portable ./scripts/portable
COPY scripts/updater.cjs ./scripts/updater.cjs
COPY scripts/updater-recovery.cjs ./scripts/updater-recovery.cjs
RUN node scripts/portable/gen-server-deps.cjs . /tmp/server-deps-check \
    && cmp /tmp/server-deps-check/package.json scripts/portable/server-deps/package.json \
    && mkdir server-deps \
    && cp scripts/portable/server-deps/package.json scripts/portable/server-deps/pnpm-lock.yaml server-deps/
# --ignore-workspace is required: /app/pnpm-workspace.yaml (packages: ['.'])
# is copied above for the build-script allowlist, and without this pnpm walks
# up from server-deps/, installs the app's own root project into
# /app/node_modules, and leaves /app/server-deps/node_modules missing — which
# the runtime stage's COPY then fails on.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store cd server-deps && pnpm install --prod --frozen-lockfile --ignore-workspace

# ------------------------------------------------------------------------------------------

FROM base AS builder
COPY . .
# Install including dev deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm build

# ------------------------------------------------------------------------------------------

FROM base AS runtime
ARG TARGETARCH
WORKDIR /app

# Install cloudflared for remote access tunnel support
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH}" \
       -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
COPY --from=deps /app/server-deps/node_modules /app/node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/packages/risubard-core ./packages/risubard-core
COPY --from=builder /app/src/ts/risubard ./src/ts/risubard
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 7777

CMD ["pnpm", "runserver"]

# ------------------------------------------------------------------------------------------
