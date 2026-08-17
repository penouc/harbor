/**
 * Harbor Containers Worker — proxies all HTTP and WebSocket traffic to
 * a single Node Express container. The Express app is unchanged; this
 * file is only the Cloudflare front door.
 *
 * WebSocket: Container.fetch() forwards Upgrade requests to the
 * container's /ws endpoint (same port as HTTP). Do not use
 * containerFetch() from an override if you need WS — call super.fetch()
 * after the container is up.
 *
 * Secrets live on the Worker (`wrangler secret put`) and are copied into
 * the container as process env at start. See docs/CLOUDFLARE.md.
 */
import { Container, getContainer } from '@cloudflare/containers'
import { env } from 'cloudflare:workers'

/** Secret / var names copied from the Worker env into the container. */
const PASSTHROUGH_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'AGENT_RUNTIME_SECRET',
  'OPENAI_MODEL',
  'OPENAI_MODEL_SUPPORT',
  'OPENAI_COMPACTION_MODEL',
  'OPENAI_IMAGE_MODEL',
  'ALERT_WEBHOOK_URL',
  'DISCORD_ALERT_WEBHOOK_URL',
  'PUBLIC_HOST',
  'CUMORA_PUBLIC_ORIGIN',
  'CUMORA_AUTH_DONE_URL',
  'CUMORA_AUTH_RETURN_ALLOWLIST',
  'CUMORA_INVITE_BASE_URL',
  'CUMORA_CORS_ORIGINS',
  'CUMORA_ADMIN_EMAILS',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_PUBLIC_BASE',
  'R2_URL_SIGNING_SECRET',
  'RESEND_API_KEY',
  'EMAIL_DOMAIN',
  'EMAIL_INBOUND_HMAC_SECRET',
  'SKILLHUB_URL',
  'SUB2API_INTERNAL_URL',
  'SUB2API_PUBLIC_URL',
  'SUB2API_ADMIN_KEY',
  'METRICS_BEARER_TOKEN',
] as const

function readString(env: Env, key: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function harborContainerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: '5181',
    // Cloudflare has no Kubernetes. Disable kubectl-backed loops so boot
    // does not spam "kubectl: not found" every 60s. Agents run via BYOA
    // (`npx cumora agent computer` on a Mac/VPS). See docs/BYOA.md.
    ENABLE_AGENT_POD_GC: 'false',
    ENABLE_CHROME_PVC_GC: 'false',
    ENABLE_CLUSTER_MONITOR: 'false',
    // In-container loopback — k8s pods do not exist here. BYOA daemons
    // use the public origin, not this URL.
    AGENT_RUNTIME_SERVER_URL: 'http://127.0.0.1:5181/runtime',
  }

  for (const key of PASSTHROUGH_KEYS) {
    const v = readString(env, key)
    if (v) out[key] = v
  }

  const origin = out.CUMORA_PUBLIC_ORIGIN?.replace(/\/+$/, '')
  if (origin) {
    if (!out.CUMORA_AUTH_DONE_URL) out.CUMORA_AUTH_DONE_URL = `${origin}/`
    if (!out.CUMORA_AUTH_RETURN_ALLOWLIST) out.CUMORA_AUTH_RETURN_ALLOWLIST = `${origin}/`
    if (!out.CUMORA_INVITE_BASE_URL) out.CUMORA_INVITE_BASE_URL = origin
  }

  return out
}

export class HarborContainer extends Container<Env> {
  // Must match Dockerfile EXPOSE / ENV PORT and server/src/env.ts default.
  defaultPort = 5181
  // After this idle window with no HTTP/WS activity, Cloudflare sends
  // SIGTERM and the instance sleeps. Next request cold-starts (migrations
  // already applied; listen is faster). WS clients disconnect on sleep.
  // Raise this (e.g. "2h") if you want the API + schedulers to stay warm.
  sleepAfter = '30m'
  envVars = harborContainerEnv(env)

  override async fetch(request: Request): Promise<Response> {
    // First boot runs SQL migrations before listen(); 20s default can miss
    // an empty Neon database. Wait up to 2 minutes, then proxy (HTTP + WS).
    await this.startAndWaitForPorts({
      ports: [this.defaultPort],
      cancellationOptions: {
        abort: request.signal,
        instanceGetTimeoutMS: 60_000,
        portReadyTimeoutMS: 120_000,
      },
    })
    return super.fetch(request)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Singleton: one Express process. getContainer() without a name uses
    // the stable id `cf-singleton-container`.
    return getContainer(env.HARBOR).fetch(request)
  },
}
