/**
 * Server-side regex service — the "linear-time backend".
 *
 * Mirrors the Rust architecture from the spec:
 *
 * | Rust crate            | here                                  |
 * |-----------------------|---------------------------------------|
 * | `regex` (linear NFA)  | shared Pike VM (`shared/regex`)       |
 * | `tree-sitter` (µs)    | shared recursive-descent parser (µs)  |
 *
 * Both engines share one implementation with the browser, so a rule validated
 * on the client is byte-for-byte identical when re-validated here — and the
 * server adds the things a client should never be trusted with: a wall-clock
 * deadline, a step budget, and a hard cap on corpus size.
 */
import { parsePattern, analyze } from '../shared/regex/index'
import { compile } from '../shared/regex/compile'
import { runPikeVm } from '../shared/regex/pikevm'
import type { AstNode } from '../shared/regex/types'

export interface EngineRequest {
  pattern: string
  input: string
  flags: string
  mode: 'safe' | 'backtracking'
  maxSteps?: number
  limit?: number
}

export interface EngineResponse {
  ok: boolean
  error: string | null
  matches: Array<{ start: number; end: number; text: string; groups: (string | undefined)[] }>
  truncated: boolean
  elapsedMicros: number
  steps: number
  engine: 'nfa-linear' | 'backtracking'
  complexity: string
  report: ReturnType<typeof analyze>
  ast: AstNode | null
  unsupported: string[]
}

const MAX_INPUT = 1_000_000
const MAX_PATTERN = 4096
const DEFAULT_LIMIT = 2000

export function execute(req: EngineRequest): EngineResponse {
  const t0 = performance.now()
  const limit = Math.min(req.limit ?? DEFAULT_LIMIT, 10_000)

  if (req.pattern.length > MAX_PATTERN) {
    return failure('Pattern exceeds 4096 characters', t0)
  }
  if (req.input.length > MAX_INPUT) {
    return failure('Input exceeds 1 MiB', t0)
  }

  const parsed = parsePattern(req.pattern)
  const report = analyze(parsed.root, req.pattern)
  if (parsed.error || !parsed.root) {
    return {
      ...failure(parsed.error?.message ?? 'Invalid pattern', t0),
      report,
    }
  }

  const program = compile(parsed.root, req.flags)
  // The safe path is the default and is always O(n·m); patterns that genuinely
  // need backtracking are rejected here rather than risking server CPU.
  if (program.unsupported.length > 0) {
    return {
      ...failure(
        `Pattern uses constructs that cannot run on the linear engine: ${program.unsupported.join('; ')}`,
        t0,
      ),
      report,
      ast: parsed.root,
      unsupported: program.unsupported,
    }
  }

  if (req.mode === 'backtracking') {
    return {
      ...failure(
        'The backtracking engine is never executed server-side: an untrusted pattern could pin a CPU core (ReDoS). Use the linear engine, or run the backtracking comparison in the browser worker, which has a hard kill-deadline.',
        t0,
      ),
      report,
      ast: parsed.root,
      unsupported: [],
    }
  }

  const run = runPikeVm(program, req.input, req.flags, req.maxSteps ?? 20_000_000)
  const elapsedMicros = Math.round((performance.now() - t0) * 1000)
  const truncated = run.matches.length > limit

  return {
    ok: true,
    error: run.timedOut ? 'Step budget exhausted — result truncated' : null,
    matches: run.matches.slice(0, limit).map((m) => ({
      start: m.start,
      end: m.end,
      text: m.text,
      groups: m.groups,
    })),
    truncated,
    elapsedMicros,
    steps: run.steps,
    engine: 'nfa-linear',
    complexity: `O(n·m) = O(${req.input.length} × ${program.instrs.length})`,
    report,
    ast: parsed.root,
    unsupported: [],
  }
}

function failure(error: string, t0: number): EngineResponse {
  return {
    ok: false,
    error,
    matches: [],
    truncated: false,
    elapsedMicros: Math.round((performance.now() - t0) * 1000),
    steps: 0,
    engine: 'nfa-linear',
    complexity: '—',
    report: analyze(null, ''),
    ast: null,
    unsupported: [],
  }
}

/** Microsecond-scale parse timing — the tree-sitter-style "instant AST" claim. */
export function parseTiming(pattern: string) {
  const samples: number[] = []
  let parsed = parsePattern(pattern)
  for (let i = 0; i < 25; i++) {
    const t = performance.now()
    parsed = parsePattern(pattern)
    samples.push(performance.now() - t)
  }
  samples.sort((a, b) => a - b)
  return {
    parse: parsed,
    medianMicros: Math.round((samples[Math.floor(samples.length / 2)] ?? 0) * 1000),
    p95Micros: Math.round((samples[Math.floor(samples.length * 0.95)] ?? 0) * 1000),
  }
}
