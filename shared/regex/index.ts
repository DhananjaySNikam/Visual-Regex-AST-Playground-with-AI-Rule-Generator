/**
 * Engine facade. Single entry point used by both the Web Worker (client) and the
 * HTTP API (server), so the browser and the backend can never disagree about a
 * pattern's semantics.
 */
import { parsePattern } from './parser'
import { compile } from './compile'
import { runPikeVm } from './pikevm'
import { runBacktracking } from './backtrack'
import { analyze } from './analyze'
import type { MatchOptions, MatchResult, MatchSpan } from './types'

export * from './types'
export { parsePattern, forEachNode, findNode, nodeAtOffset } from './parser'
export { compile, testCharSet } from './compile'
export { analyze } from './analyze'
export { runPikeVm } from './pikevm'
export { runBacktracking, nestedStarHeight } from './backtrack'

const PERFECT_MATCH_LIMIT = 5000

export function runMatch(opts: MatchOptions): MatchResult {
  const t0 = performance.now()
  const parse = parsePattern(opts.pattern)

  if (parse.error || !parse.root) {
    return {
      matches: [],
      error: parse.error?.message ?? null,
      stats: {
        engine: opts.mode,
        steps: 0,
        elapsedMs: performance.now() - t0,
        complexity: '—',
        timedOut: false,
      },
      parse,
    }
  }

  const program = compile(parse.root, opts.flags)
  const maxSteps = opts.maxSteps ?? 4_000_000
  let matches: MatchSpan[] = []
  let steps = 0
  let timedOut = false
  let engine: MatchResult['stats']['engine'] = 'safe'
  let fallbackReason: string | undefined
  let error: string | null = null

  const mustBacktrack = program.unsupported.length > 0 || opts.mode === 'backtracking'

  if (!mustBacktrack) {
    const run = runPikeVm(program, opts.input, opts.flags, maxSteps)
    matches = run.matches
    steps = run.steps
    timedOut = run.timedOut
  } else {
    if (opts.mode === 'safe' && program.unsupported.length > 0) {
      fallbackReason = program.unsupported[0]
      engine = 'fallback'
    } else {
      engine = 'backtracking'
    }
    const run = runBacktracking(opts.pattern, opts.input, opts.flags, maxSteps)
    matches = run.matches
    steps = run.steps
    timedOut = run.timedOut
    error = run.error
  }

  // Guard rail: never ship an unrenderable number of spans to the UI.
  const trimmed = matches.length > PERFECT_MATCH_LIMIT ? matches.slice(0, PERFECT_MATCH_LIMIT) : matches

  return {
    matches: trimmed,
    error,
    stats: {
      engine,
      steps,
      elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
      complexity: engine === 'safe' ? 'O(n · m) linear' : 'O(2ⁿ) backtracking',
      timedOut,
      fallbackReason,
    },
    parse,
  }
}

export function analyzePattern(pattern: string, flags = '') {
  const parse = parsePattern(pattern)
  return {
    parse,
    report: analyze(parse.root, pattern),
    programUnsupported: parse.root ? compile(parse.root, flags).unsupported : [],
  }
}
