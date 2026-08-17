# Harbor / Cumora — Cloudflare Containers production image.
#
# Runs the existing Node Express API + WebSocket server and serves the
# built Vite SPA from the same origin (port 5181). Postgres and Redis are
# NOT in this image — point DATABASE_URL and REDIS_URL at Neon / Upstash
# (or any external providers) via Worker secrets.
#
# GKE still builds from server/docker/cumora-server.Dockerfile (Node 20 +
# kubectl for managed agent pods). This file is the Cloudflare path:
# Node 22, no kubectl, single listen port.
#
# Build locally (from repo root):
#   docker build -t harbor:local .
#
# wrangler deploy builds and pushes this image automatically.

# ─── stage 1: production Node deps ──────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `--omit=dev` skips electron / vite / biome. Runtime needs tsx (it lives
# in dependencies) plus express, pg, ioredis, ws, etc.
RUN npm ci --omit=dev --no-audit --no-fund --prefer-offline

# ─── stage 2: Vite SPA ──────────────────────────────────────────────
# Full install so vite + tsc + tailwind run. Output is /app/dist only.
#
# VITE_CUMORA_API_BASE is left empty so the SPA uses relative `/api` and
# `/ws` against this container (the Worker proxies the same origin).
# Do NOT COPY .env.production — that file bakes https://api.cumora.ai
# for Cumora's Electron/desktop release, which would break Harbor.
FROM node:22-bookworm-slim AS spa-build
WORKDIR /app
ARG VITE_CUMORA_API_BASE=""
ARG VITE_PUBLIC_POSTHOG_KEY=""
ARG VITE_PUBLIC_POSTHOG_HOST=""
ENV VITE_CUMORA_API_BASE=${VITE_CUMORA_API_BASE}
ENV VITE_PUBLIC_POSTHOG_KEY=${VITE_PUBLIC_POSTHOG_KEY}
ENV VITE_PUBLIC_POSTHOG_HOST=${VITE_PUBLIC_POSTHOG_HOST}
COPY package.json package-lock.json ./
# --ignore-scripts: electron-icon-builder pulls phantomjs-prebuilt, whose
# postinstall needs bzip2 (missing on slim). Vite/tsc don't need it.
RUN npm ci --no-audit --no-fund --prefer-offline --ignore-scripts
COPY src ./src
COPY public ./public
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY tsconfig.node.json ./
COPY postcss.config.js ./
COPY tailwind.config.ts ./
RUN npm run build

# ─── stage 3: runtime ───────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       tini \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node bin ./bin
# server/src/index.ts serves this when NODE_ENV=production and index.html exists.
COPY --from=spa-build --chown=node:node /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=5181

USER node
EXPOSE 5181

# tini reaps zombies and forwards SIGTERM from the Containers runtime.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "server:start"]
