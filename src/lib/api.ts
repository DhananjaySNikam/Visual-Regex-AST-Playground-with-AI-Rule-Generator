/**
 * Thin API client. All calls are same-origin (`/api/...`) so the Vite dev proxy
 * and the production static server both work without CORS or hard-coded hosts.
 */
import type { AnalyzeReport, AstNode, ParseResult } from '../../shared/regex/types'

export interface ProviderStatus {
  mode: 'live' | 'local'
  providers: Array<{ name: string; model: string }>
  note: string
}

export interface HealthResponse {
  ok: boolean
  uptimeMs: number
  node: string
  engine: string
  store: { kind: string; ttlHours: number; entries: number; expired: number; bytes: number }
  ai: ProviderStatus
  architecture: { time: string; space: string }
}

export interface GeneratedRule {
  id: string
  title: string
  intent: string
  pattern: string
  flags: string
  explanation: string
  examples: { match: string[]; reject: string[] }
  nodes: AstNode | null
  risk: AnalyzeReport
  source: 'groq' | 'gemini' | 'local'
  latencyMs: number
  candidates?: Array<{ pattern: string; why: string; score: number }>
}

export interface ReviewResult {
  summary: string
  severity: 'low' | 'medium' | 'high'
  findings: Array<{ title: string; detail: string; rewrite?: string }>
  optimized?: { pattern: string; why: string; riskAfter: AnalyzeReport }
  source: 'groq' | 'gemini' | 'local'
}

export interface Example {
  id: string
  title: string
  prompt: string
  pattern: string
  flags: string
  corpus: string
  note: string
}

export interface ServerRunResult {
  ok: boolean
  error: string | null
  matches: Array<{ start: number; end: number; text: string; groups: (string | undefined)[] }>
  truncated: boolean
  elapsedMicros: number
  steps: number
  engine: string
  complexity: string
  report: AnalyzeReport
  ast: AstNode | null
  unsupported: string[]
}

export interface ShareResponse {
  code: string
  bytes: number
  ratio: number
  url: string
  stored: { id: string; expiresAt: number } | null
}

const TIMEOUT = 20_000

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`Malformed response from ${path}`)
    }
    if (!res.ok) {
      const msg = (json as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
      throw new Error(msg)
    }
    return json as T
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  health: async () => {
    const res = await request<HealthResponse>('/api/health')
    // Tolerate older/partial backends instead of crashing the shell.
    return {
      ...res,
      ok: res?.ok ?? false,
      store: res?.store ?? { kind: 'unknown', ttlHours: 24, entries: 0, expired: 0, bytes: 0 },
      ai: res?.ai ?? { mode: 'local' as const, providers: [], note: '' },
      architecture: res?.architecture ?? { time: '', space: '' },
    }
  },
  examples: () => request<{ examples: Example[] }>('/api/examples'),
  generate: (prompt: string, flags?: string) =>
    request<{ rule: GeneratedRule }>('/api/ai/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, flags }),
    }),
  review: (pattern: string, flags: string) =>
    request<{ review: ReviewResult }>('/api/ai/review', {
      method: 'POST',
      body: JSON.stringify({ pattern, flags }),
    }),
  serverRun: (pattern: string, input: string, flags: string) =>
    request<ServerRunResult>('/api/regex/run', {
      method: 'POST',
      body: JSON.stringify({ pattern, input, flags }),
    }),
  parse: (pattern: string) =>
    request<{ parse: ParseResult; medianMicros: number; p95Micros: number }>('/api/regex/parse', {
      method: 'POST',
      body: JSON.stringify({ pattern }),
    }),
  share: (payload: unknown, persist = false) =>
    request<ShareResponse>('/api/share', { method: 'POST', body: JSON.stringify({ payload, persist }) }),
  decodeShare: (code: string) =>
    request<{ payload: unknown }>('/api/share/decode', { method: 'POST', body: JSON.stringify({ code }) }),
  fetchShare: (id: string) => request<{ payload: unknown; expiresAt: number; hits: number }>(`/api/share/${id}`),
}
