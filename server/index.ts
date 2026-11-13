/**
 * HTTP API for the Visual Regex & AST Playground.
 *
 *   GET  /api/health              liveness + engine + store + AI mode
 *   GET  /api/examples            curated patterns with corpora
 *   POST /api/regex/run           linear-time match (Pike VM, server deadline)
 *   POST /api/regex/parse         AST + microsecond parse timings
 *   POST /api/regex/analyze       static risk report
 *   GET  /api/regex/compare?…     safe engine vs backtracking estimate
 *   POST /api/ai/generate         natural language → regex + AST
 *   POST /api/ai/review           performance / vulnerability explainer
 *   POST /api/share               zstd-compress a playground → URL-safe code
 *   GET  /api/share/:id           resolve a stored share (24h TTL)
 *   GET  /api/store/stats         ephemeral store metrics
 *
 * The server is stateless by default: `/api/share` with `{ inline: true }` (the
 * default) returns a code that the client puts straight into the URL hash, so
 * nothing is ever stored. Only `{ persist: true }` touches SQLite.
 */
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openStore } from './store'
import { decodeShare, encodeShare, type SharePayload } from './share'
import { execute, parseTiming } from './regexService'
import { generateRule, providerStatus, reviewPattern } from './ai'
import { EXAMPLES } from './examples'
import { loadEnv } from './env'

loadEnv()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

const app = express()
app.use(express.json({ limit: '2mb' }))

// Permissive CORS: the preview proxy and localhost dev origins must both work.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

const startedAt = Date.now()
let store: Awaited<ReturnType<typeof openStore>> | null = null

function body<T>(req: express.Request): T {
  return (req.body ?? {}) as T
}

app.get('/api/health', async (_req, res) => {
  const s = store
  const stats = s ? await s.stats() : { entries: 0, expired: 0, bytes: 0 }
  res.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    node: process.version,
    engine: 'linear-nfa (Pike VM) + shared recursive-descent parser',
    store: { kind: s?.kind ?? 'none', ttlHours: 24, ...stats },
    ai: providerStatus(),
    // Mirrors the Rust design decisions this service stands in for.
    architecture: {
      time: 'O(n·m) guaranteed on the NFA engine; parse timings in microseconds',
      space: 'stateless by default; shares are zstd-compressed into the URL',
    },
  })
})

app.get('/api/examples', (_req, res) => {
  res.json({ examples: EXAMPLES })
})

app.post('/api/regex/run', (req, res) => {
  const b = body<{ pattern?: string; input?: string; flags?: string; mode?: 'safe' | 'backtracking'; limit?: number }>(req)
  if (typeof b.pattern !== 'string') {
    res.status(400).json({ error: 'pattern (string) is required' })
    return
  }
  res.json(
    execute({
      pattern: b.pattern,
      input: typeof b.input === 'string' ? b.input : '',
      flags: typeof b.flags === 'string' ? b.flags : '',
      mode: b.mode === 'backtracking' ? 'backtracking' : 'safe',
      limit: typeof b.limit === 'number' ? b.limit : undefined,
    }),
  )
})

app.post('/api/regex/parse', (req, res) => {
  const b = body<{ pattern?: string }>(req)
  if (typeof b.pattern !== 'string') {
    res.status(400).json({ error: 'pattern (string) is required' })
    return
  }
  const timing = parseTiming(b.pattern)
  res.json({
    parse: timing.parse,
    medianMicros: timing.medianMicros,
    p95Micros: timing.p95Micros,
  })
})

app.post('/api/regex/analyze', (req, res) => {
  const b = body<{ pattern?: string; flags?: string }>(req)
  if (typeof b.pattern !== 'string') {
    res.status(400).json({ error: 'pattern (string) is required' })
    return
  }
  const out = execute({ pattern: b.pattern, input: '', flags: b.flags ?? '', mode: 'safe' })
  res.json({ report: out.report, ast: out.ast, unsupported: out.unsupported })
})

app.get('/api/regex/compare', (req, res) => {
  const pattern = String(req.query.pattern ?? '')
  const input = String(req.query.input ?? '')
  const flags = String(req.query.flags ?? '')
  const out = execute({ pattern, input, flags, mode: 'safe' })
  res.json({
    safe: out,
    // The backtracking engine is intentionally never executed server-side; the
    // comparison uses the shared cost model so the API stays un-abuseable.
    note: 'Backtracking is not executed on the server: an untrusted pattern could pin a core (ReDoS). The client worker demonstrates it under a hard kill-deadline instead.',
  })
})

app.post('/api/ai/generate', async (req, res) => {
  const b = body<{ prompt?: string; flags?: string }>(req)
  if (typeof b.prompt !== 'string' || b.prompt.trim().length === 0) {
    res.status(400).json({ error: 'prompt (string) is required' })
    return
  }
  if (b.prompt.length > 800) {
    res.status(400).json({ error: 'prompt must be under 800 characters' })
    return
  }
  try {
    const rule = await generateRule({ prompt: b.prompt, flags: b.flags })
    res.json({ rule })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/ai/review', async (req, res) => {
  const b = body<{ pattern?: string; flags?: string }>(req)
  if (typeof b.pattern !== 'string') {
    res.status(400).json({ error: 'pattern (string) is required' })
    return
  }
  try {
    res.json({ review: await reviewPattern(b.pattern, b.flags ?? '') })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/share', async (req, res) => {
  const b = body<{ payload?: SharePayload; persist?: boolean }>(req)
  if (!b.payload || typeof b.payload.p !== 'string') {
    res.status(400).json({ error: 'payload with at least { p, f, t } is required' })
    return
  }
  try {
    const { code, bytes, ratio } = encodeShare({ ...b.payload, v: 1, c: Date.now() })
    let stored: { id: string; expiresAt: number } | null = null
    if (b.persist && store) {
      const row = await store.save(code)
      stored = { id: row.id, expiresAt: row.expiresAt }
    }
    res.json({
      code,
      bytes,
      ratio: Math.round(ratio * 100) / 100,
      url: `#s=${code}`,
      stored,
    })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.get('/api/share/:id', async (req, res) => {
  if (!store) {
    res.status(503).json({ error: 'store unavailable' })
    return
  }
  const row = await store.get(req.params.id)
  if (!row) {
    res.status(404).json({ error: 'share not found or expired (24h TTL)' })
    return
  }
  try {
    res.json({ payload: decodeShare(row.code), expiresAt: row.expiresAt, hits: row.hits })
  } catch (err) {
    res.status(422).json({ error: (err as Error).message })
  }
})

app.get('/api/store/stats', async (_req, res) => {
  if (!store) {
    res.status(503).json({ error: 'store unavailable' })
    return
  }
  res.json({ kind: store.kind, ttlHours: 24, ...(await store.stats()) })
})

/** Decode a `#s=` code on the server (used to validate deep links). */
app.post('/api/share/decode', (req, res) => {
  const b = body<{ code?: string }>(req)
  if (typeof b.code !== 'string') {
    res.status(400).json({ error: 'code (string) is required' })
    return
  }
  try {
    res.json({ payload: decodeShare(b.code) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// ---------------------------------------------------------------------------
// Static hosting (production build) — one process, one port.
// ---------------------------------------------------------------------------
const distDir = path.resolve(__dirname, '..', 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: false }))
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

const server = app.listen(PORT, HOST, async () => {
  store = await openStore()
  const sweep = setInterval(() => {
    store?.sweep().catch(() => {})
  }, 5 * 60 * 1000)
  sweep.unref?.()
  console.log(`[api] listening on http://${HOST}:${PORT} (store: ${store.kind})`)
})

function shutdown(signal: string) {
  console.log(`[api] ${signal} received, closing`)
  server.close(() => {
    void store?.close().then(() => process.exit(0))
  })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
