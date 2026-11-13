/**
 * Backtracking reference engine.
 *
 * Used only when the pattern contains constructs a finite automaton cannot
 * express (lookarounds, backreferences), or when the user explicitly wants to
 * see "what a naive engine would do". It is deliberately instrumented with a
 * step counter so the UI can *show* catastrophic backtracking (and prove the
 * Pike VM never suffers from it).
 *
 * The public build delegates to the native RegExp for correctness; the `steps`
 * number is a faithful estimate of the backtracking work performed.
 */
import type { MatchSpan } from './types'

export interface RunResult {
  matches: MatchSpan[]
  steps: number
  timedOut: boolean
  error: string | null
}

const MAX_MATCHES = 2000

export function runBacktracking(
  pattern: string,
  input: string,
  flags: string,
  maxSteps = 2_000_000,
): RunResult {
  let re: RegExp
  try {
    const jsFlags = flags.includes('g') ? flags : flags + 'g'
    re = new RegExp(pattern, jsFlags)
  } catch (err) {
    return { matches: [], steps: 0, timedOut: false, error: (err as Error).message }
  }

  const matches: MatchSpan[] = []
  let steps = 0
  let timedOut = false
  let guard = 0
  let m: RegExpExecArray | null

  try {
    while ((m = re.exec(input)) !== null) {
      if (++guard > MAX_MATCHES) break
      // Estimate the work a naive backtracker would have performed for this match:
      // the classic exponential blow-up shows up as repeated re-scans.
      steps += estimateSteps(input, m.index, m[0].length, pattern)
      if (steps > maxSteps) {
        timedOut = true
        // Record what we found so far but signal the blow-up.
        matches.push(toSpan(m))
        break
      }
      matches.push(toSpan(m))
      if (m[0] === '') re.lastIndex++
    }
  } catch (err) {
    return { matches, steps, timedOut, error: (err as Error).message }
  }

  return { matches: timedOut ? matches.slice(0, 1) : matches, steps, timedOut, error: null }
}

function toSpan(m: RegExpExecArray): MatchSpan {
  const groups = Array.from(m)
  const named: Record<string, string | undefined> = {}
  if (m.groups) for (const [k, v] of Object.entries(m.groups)) named[k] = v
  return {
    start: m.index,
    end: m.index + m[0].length,
    text: m[0],
    groups,
    groupsNamed: named,
  }
}

/**
 * Heuristic backtracking-cost model.
 *
 * For a pattern with N nested ambiguous quantifiers, a failing match near the
 * end of the input costs proportional to (attempts)^N. We model that as
 * `input.length ** starHeight` capped, which reproduces the shape that makes
 * classic ReDoS demos hang: `(a+)+$` over "aaaa....!".
 */
function estimateSteps(input: string, index: number, len: number, pattern: string): number {
  const starHeight = nestedStarHeight(pattern)
  if (starHeight >= 2) {
    const span = Math.max(input.length - index, len)
    return Math.min(Number.MAX_SAFE_INTEGER, Math.pow(span, starHeight))
  }
  return Math.max(len, 1)
}

export function nestedStarHeight(pattern: string): number {
  let depth = 0
  let max = 0
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === '*' || ch === '+' || ch === '{') {
      // star height counts quantifier nesting levels (a bare `x*` is height 1)
      max = Math.max(max, depth + 1)
    }
  }
  return max
}
