/**
 * Unit tests for BYOA local engine adapters.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine.test.ts
 */
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter } from '../agents/computer/engine.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('local engine failure returns stderr tail for observability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: usage limit reached, no tokens left" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const result = await getAdapter('claude').run({
    home,
    prompt: 'wake',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /usage limit reached, no tokens left/i)
  assert.deepEqual(logs, ['Claude Code error: usage limit reached, no tokens left'])
})

test('persistent Claude startup failure keeps stderr for first send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-session-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: subscription expired" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const session = getAdapter('claude').startSession?.({
    home,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
  })

  assert.ok(session)
  await delay(50)
  const result = await session.send('wake')

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /subscription expired/i)
  // The engine's stderr passes through verbatim, followed by the session-death
  // trace (die() now ALWAYS logs a process death — idle deaths used to be
  // silent, which made fleet-wide session disappearances undiagnosable).
  assert.equal(logs[0], 'Claude Code error: subscription expired')
  assert.equal(logs.length, 2)
  assert.match(logs[1] ?? '', /\[session\] engine process died .*exit 1/)
})

test('ENGINE_IDS lists claude, codex, then opencode, pi, omp, dsh', async () => {
  const { ENGINE_IDS, getAdapter } = await import('../agents/computer/engine.js')
  assert.deepEqual(ENGINE_IDS, ['claude', 'codex', 'opencode', 'pi', 'omp', 'dsh'])
  assert.equal(getAdapter('opencode').bin, 'opencode')
  assert.equal(getAdapter('pi').bin, 'pi')
  assert.equal(getAdapter('omp').bin, 'omp')
  assert.equal(getAdapter('dsh').bin, 'dsh')
})

test('new engines seed AGENTS.md without clobbering memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-seed-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  const persona = { id: 'iris', name: 'Iris', role: 'researcher' }
  await getAdapter('opencode').seedHome(home, persona)
  const { readFile } = await import('node:fs/promises')
  const agentsMd = await readFile(join(home, 'AGENTS.md'), 'utf8')
  assert.match(agentsMd, /Iris/)
  assert.match(agentsMd, /AGENTS\.md/)
  const memory = await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8')
  await writeFile(join(home, 'memory', 'MEMORY.md'), memory + '\nkept\n', 'utf8')
  await writeFile(join(home, 'AGENTS.md'), 'do not clobber\n', 'utf8')
  await getAdapter('pi').seedHome(home, persona)
  assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), 'do not clobber\n')
  assert.match(await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8'), /kept/)
})

test('dsh has no persistent session; custom args disable OpenCode/Pi sessions', () => {
  const home = tmpdir()
  const opts = { home, env: process.env, onLog: () => {} }
  assert.equal(getAdapter('dsh').startSession?.(opts) ?? null, null)
  const prevOpen = process.env.CUMORA_OPENCODE_ARGS
  const prevPi = process.env.CUMORA_PI_ARGS
  const prevOmp = process.env.CUMORA_OMP_ARGS
  process.env.CUMORA_OPENCODE_ARGS = '--auto'
  process.env.CUMORA_PI_ARGS = '-p'
  process.env.CUMORA_OMP_ARGS = '-p'
  try {
    assert.equal(getAdapter('opencode').startSession?.(opts) ?? null, null)
    assert.equal(getAdapter('pi').startSession?.(opts) ?? null, null)
    assert.equal(getAdapter('omp').startSession?.(opts) ?? null, null)
  } finally {
    if (prevOpen === undefined) delete process.env.CUMORA_OPENCODE_ARGS
    else process.env.CUMORA_OPENCODE_ARGS = prevOpen
    if (prevPi === undefined) delete process.env.CUMORA_PI_ARGS
    else process.env.CUMORA_PI_ARGS = prevPi
    if (prevOmp === undefined) delete process.env.CUMORA_OMP_ARGS
    else process.env.CUMORA_OMP_ARGS = prevOmp
  }
})

test('Pi RPC session waits for agent_settled, not agent_end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-pi-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakePi = join(binDir, 'pi')
  await writeFile(
    fakePi,
    '#!/bin/sh\n' +
    'printf "%s\\n" \'{"type":"ready"}\'\n' +
    'IFS= read -r _line\n' +
    'printf "%s\\n" \'{"type":"agent_start"}\'\n' +
    'printf "%s\\n" \'{"type":"agent_end","willRetry":true}\'\n' +
    'printf "%s\\n" \'{"type":"message_end","message":{"role":"assistant","model":"test-model","usage":{"input":10,"output":4},"content":[{"type":"text","text":"hi"}]}}\'\n' +
    'printf "%s\\n" \'{"type":"agent_settled"}\'\n' +
    'cat >/dev/null\n',
    'utf8',
  )
  await chmod(fakePi, 0o755)

  const hops: Array<{ model: string }> = []
  const session = getAdapter('pi').startSession?.({
    home,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: 'test-model',
    fastModel: null,
    onLog: () => {},
    onHopUsage: (r) => hops.push(r),
  })
  assert.ok(session)
  const result = await session.send('wake')
  assert.equal(result.exitCode, 0)
  assert.equal(result.model, 'test-model')
  assert.equal(result.usage?.input_tokens, 10)
  assert.equal(result.usage?.output_tokens, 4)
  assert.equal(hops.length, 1)
  session.stop()
})

test('byoaSource is byoa-<engine id> for ledger/triage hops', async () => {
  const { byoaSource, ENGINE_IDS } = await import('../agents/computer/engine.js')
  assert.equal(byoaSource('claude'), 'byoa-claude')
  assert.equal(byoaSource('codex'), 'byoa-codex')
  assert.equal(byoaSource('opencode'), 'byoa-opencode')
  assert.equal(byoaSource('pi'), 'byoa-pi')
  assert.equal(byoaSource('omp'), 'byoa-omp')
  assert.equal(byoaSource('dsh'), 'byoa-dsh')
  for (const id of ENGINE_IDS) assert.equal(byoaSource(id), `byoa-${id}`)
})
