# Deploy Harbor on Cloudflare Containers

Run the existing Node API (Express + `ws`) and the built Vite SPA in a
**Cloudflare Container**, fronted by a small Worker. This does **not**
rewrite the app into a Worker.

Cloudflare Containers require a **Workers Paid** plan.
See [Containers](https://developers.cloudflare.com/containers/).

## What you get

```
browser  ──HTTP + WebSocket──▶  Worker (workers/harbor)
                                  │  getContainer(env.HARBOR).fetch()
                                  ▼
                                Container (Dockerfile)
                                  Express :5181
                                  ├─ /api, /runtime, /uploads
                                  ├─ /ws
                                  └─ Vite dist/ (SPA)
                                        │
                         Neon Postgres ◀─┤
                         Upstash Redis ◀─┘
```

The server already serves the SPA in production when `NODE_ENV=production`
and `dist/index.html` exists (`server/src/index.ts`). HTTP and WebSocket
share port **5181**. Postgres and Redis stay **outside** the image.

## Prerequisites

- Docker running locally (`docker info` succeeds) — `wrangler deploy`
  builds and pushes the image.
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (dev
  dependency of this repo) and a Cloudflare account on **Workers Paid**.

```bash
npx wrangler login
```

## External data stores (required)

Do **not** run Postgres or Redis in the container.

| Need | Typical provider | Notes |
|---|---|---|
| Postgres | [Neon](https://neon.tech) | Use the pooled URI with `sslmode=require`. Enable the `vector` extension if you want semantic memory (`CREATE EXTENSION IF NOT EXISTS vector`). The server already tries this at boot and degrades if it is missing. |
| Redis | [Upstash](https://upstash.com) | Redis-compatible. Use the TLS URL (`rediss://…`). Required even with one replica — the server uses Redis pub/sub internally. |

## Secrets

Values never go in git. Wrangler prompts for each value (paste into the
terminal locally, not into chat or the PR).

**Required** (also declared in `wrangler.jsonc` → `secrets.required`, so
deploy fails closed if any are missing):

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put REDIS_URL
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put AGENT_RUNTIME_SECRET   # openssl rand -hex 32
```

`OPENAI_API_KEY` is the provider key for whatever host `OPENAI_BASE_URL`
points at (OpenAI when unset). The secret name stays `OPENAI_API_KEY`.

`AGENT_RUNTIME_SECRET` must **not** be the public-source dev default.
`server/src/env.ts` refuses to boot in production if it is.

**Public origin** (OAuth redirect_uri, invite links, pairing). Production
already uses deploy-time `CUMORA_PUBLIC_ORIGIN` (not committed). The
intended production origin is the custom domain; `workers.dev` remains a
fallback:

```bash
npx wrangler secret put CUMORA_PUBLIC_ORIGIN
# production: https://raft.is-a-nice.app
# fallback:   https://harbor.penouc.workers.dev
```

When `CUMORA_PUBLIC_ORIGIN` is set, the Worker also fills
`CUMORA_AUTH_DONE_URL` / return allow-list / invite base if you have not
set those yourself.

**Optional** — same `wrangler secret put <NAME>` as `server/src/env.ts`.
Soft-disable when unset:

| Group | Names |
|---|---|
| OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| R2 | `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE`, `R2_URL_SIGNING_SECRET` |
| Email | `RESEND_API_KEY`, `EMAIL_DOMAIN`, `EMAIL_INBOUND_HMAC_SECRET` |
| Alerts | `ALERT_WEBHOOK_URL`, `DISCORD_ALERT_WEBHOOK_URL` |
| Admin | `CUMORA_ADMIN_EMAILS` (comma-separated) |
| Models | `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_MODEL_SUPPORT`, `OPENAI_COMPACTION_MODEL` |
| Other | `SKILLHUB_URL`, `SUB2API_*`, `METRICS_BEARER_TOKEN`, `CUMORA_CORS_ORIGINS` |

Same-origin SPA + API does **not** need CORS. Set `CUMORA_CORS_ORIGINS`
only if a separately hosted client talks to this origin.

`OPENAI_BASE_URL` is empty by default (SDK talks to OpenAI). To run the
agent loop against DeepSeek V4 (native `responses.create` — do not
rewrite to Chat Completions), set these four and keep `OPENAI_API_KEY`
as the DeepSeek key:

```
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-pro
OPENAI_MODEL_SUPPORT=deepseek-v4-flash
OPENAI_COMPACTION_MODEL=deepseek-v4-flash
```

Do **not** put those values in committed `wrangler.jsonc` `vars`. Image
generation (`gpt-image-2`) and embeddings (`text-embedding-3-small`)
will fail on DeepSeek; embeddings already return `null` and fall back
to recency-only retrieval.

Full comments: [`.env.example`](../.env.example) and `server/src/env.ts`.

## Deploy

From the **repo root** (Docker must be running):

```bash
npx wrangler types
npx wrangler deploy
```

The first deploy provisions the container application; the `*.workers.dev`
URL can answer before the image is ready. Wait a few minutes, then check
**Workers & Pages → Containers** in the dashboard.

Workers Builds can run `wrangler deploy` from this repo. Keep the custom
domain in `wrangler.jsonc` (see below) so that deploy does not drop the
bind. Do not put tokens in the PR or in git.

## Custom domain: `raft.is-a-nice.app`

`raft.is-a-nice.app` is **already attached** to Worker `harbor` on zone
`is-a-nice.app`. Do not invent a Cloudflare **zone ID**. The bind is
declared in `wrangler.jsonc` so the next `wrangler deploy` does not drop
it:

```jsonc
"workers_dev": true,
"routes": [
  { "pattern": "raft.is-a-nice.app", "custom_domain": true }
]
```

`workers_dev: true` keeps `https://harbor.penouc.workers.dev` working as
a fallback. See [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

Intended production `CUMORA_PUBLIC_ORIGIN` is
`https://raft.is-a-nice.app`. That value is deploy-time (Worker secret /
Workers Builds env), not a committed `vars` entry. After it is set,
OAuth / invite / pairing use the new origin.

## Instance type

`wrangler.jsonc` sets `instance_type: "basic"` (1 GiB RAM, 1/4 vCPU,
4 GB disk).

- **Not `lite` (256 MiB)** — too small for Node 22 + Express + a 20-slot
  pg pool + Redis + WebSocket buffers.
- **Not `standard-1` (4 GiB) by default** — GKE requests 512 MiB for this
  process (2 GiB limit) *including* kubectl/agent orchestration, which
  this image does not run. 1 GiB is the intended headroom.
- If the process OOMs or RSS sits near 1 GiB, change `instance_type` to
  `"standard-1"` and redeploy.

## Sleep after idle

`HarborContainer.sleepAfter` is **30 minutes**. After that with no HTTP
or WebSocket activity, Cloudflare sends `SIGTERM` and the instance
stops. Billing for memory/CPU pauses while slept.

Effects:

- Open `/ws` connections drop; the UI reconnects on the next request.
- In-process schedulers (idle ticks, scanners, email retry) pause until
  the next request cold-starts the container.
- Disk is **not** a durable volume. Uploads in local-storage mode are
  lost on sleep/replace — configure R2 for production attachments.

Raise `sleepAfter` in `workers/harbor/src/index.ts` (for example `"2h"`)
if you want the API to stay warm.

## Agents: BYOA, not Kubernetes

Cloudflare Containers are **not** a Kubernetes cluster. The GKE path
(`kubectl` → per-agent pods + FUSE) does not run here.

Use **BYOA**: pair a Mac or VPS with `npx cumora agent computer` and
point it at this deployment's public origin. The server never holds
those provider keys. See [`docs/BYOA.md`](BYOA.md).

The Worker sets `ENABLE_AGENT_POD_GC=false` (and the chrome-PVC / cluster
monitors) so the server does not shell out to missing `kubectl`.

## Local Worker + container

```bash
npx wrangler dev
```

Needs Docker. To work on the Worker without starting the container:

```bash
npx wrangler dev --enable-containers=false
```

(Requests that call `getContainer` will fail until containers are enabled.)

## Related

- GKE image (unchanged): `server/docker/cumora-server.Dockerfile`
- Email Worker: `workers/email-gate/`
- R2 CDN Worker: `workers/r2-gate/`
