/**
 * Static vulnerability + complexity analysis.
 *
 * Everything here is O(1) in the *input* (it only walks the pattern AST), so it
 * can run on every keystroke inside the worker.
 */
import type { AnalyzeReport, AstNode } from './types'
import { forEachNode } from './parser'
import { nestedStarHeight } from './backtrack'

const CLASSIC_REDOS = [
  { re: /\(\.\*\)\+|\(\.\+\)\+|\(\.\*\)\*/, title: 'Nested wildcard quantifier' },
  { re: /\(\[[^\]]*\]\+\)\+|\(\[[^\]]*\]\*\)\*/, title: 'Nested character-class quantifier' },
  { re: /\(\\w\+\)\+|\(\\w\*\)\*/, title: 'Nested \\w quantifier' },
  { re: /\(\\d\+\)\+|\([0-9]\+\)\+/, title: 'Nested digit quantifier' },
  { re: /\([a-zA-Z]\+\)\+/, title: 'Nested letter quantifier' },
]

export function analyze(root: AstNode | null, pattern: string): AnalyzeReport {
  const findings: AnalyzeReport['findings'] = []
  let nodeCount = 0
  let maxDepth = 0
  let captureGroups = 0
  let requiresBacktracking = false
  const classes = new Set<string>()
  const quantIds: Array<{ node: AstNode; min: number; max: number | null; lazy: boolean }> = []

  const walk = (node: AstNode, depth: number) => {
    nodeCount++
    maxDepth = Math.max(maxDepth, depth)
    if (node.type === 'group' && node.captureIndex > 0) captureGroups++
    if (node.type === 'charClass') classes.add(node.items.map((i) => i.kind === 'shorthand' ? i.shorthand : `${i.from}-${i.to}`).join(','))
    if (node.type === 'lookaround' || node.type === 'backref') requiresBacktracking = true
    if (node.type === 'quantifier') quantIds.push({ node, min: node.min, max: node.max, lazy: node.lazy })
    for (const c of node.children) walk(c, depth + 1)
  }
  if (root) walk(root, 1)

  const starHeight = nestedStarHeight(pattern)

  // 1. Classic nested-quantifier ReDoS shapes
  for (const sig of CLASSIC_REDOS) {
    if (sig.re.test(pattern)) {
      findings.push({
        id: 'nested-quantifier',
        severity: 'danger',
        title: sig.title,
        detail:
          'An unbounded quantifier sits inside another unbounded quantifier. A backtracking engine may try exponentially many ways to split the same input.',
        nodeIds: quantIds.map((q) => q.node.id),
        suggestion:
          'Rewrite as a single quantifier over a precise character class, e.g. (\\w+)+ → \\w+, or anchor the match and use the linear-time engine.',
      })
      break
    }
  }

  if (starHeight >= 2 && !findings.some((f) => f.id === 'nested-quantifier')) {
    findings.push({
      id: 'star-height',
      severity: 'warn',
      title: `Star height = ${starHeight}`,
      detail:
        'Quantifiers are nested, so the number of ways to partition the input grows combinatorially for a backtracking engine.',
      nodeIds: quantIds.map((q) => q.node.id),
      suggestion: 'Flatten nested repetition or make the inner class mutually exclusive.',
    })
  }

  // 2. Leading unanchored unbounded quantifier — scans O(n²) text
  const first = root ? firstConsuming(root) : null
  if (first && first.type === 'quantifier' && first.max === null && !hasAnchorBefore(root!, first)) {
    findings.push({
      id: 'unanchored',
      severity: 'info',
      title: 'Unanchored with unbounded repetition',
      detail:
        'The pattern can start matching at any offset, so a scan over length n attempts the pattern at up to n positions (O(n²) with a naive matcher over a whole corpus).',
      nodeIds: [first.id],
      suggestion: 'Prefix with ^ (plus the m flag) if you only care about line starts.',
    })
  }

  // 3. Alternation with overlapping branches
  if (root) {
    let overlapping = false
    forEachNode(root, (n) => {
      if (n.type === 'alternation' && n.children.length > 1) {
        const firsts = n.children.map((c) => firstCharKey(c)).filter(Boolean)
        if (new Set(firsts).size < firsts.length) overlapping = true
      }
    })
    if (overlapping) {
      findings.push({
        id: 'overlap',
        severity: 'warn',
        title: 'Alternation branches share a prefix',
        detail:
          'Two branches can begin by consuming the same characters, which makes a backtracking engine retry the second branch after the first one fails.',
        nodeIds: [],
        suggestion: 'Factor the shared prefix out of the branches, or order branches so the most specific one comes first.',
      })
    }
  }

  // 4. Dot-star over large corpora
  if (/\.\*/.test(pattern) && /\.\*.*\.\*/.test(pattern)) {
    findings.push({
      id: 'dotstar',
      severity: 'warn',
      title: 'Multiple `.*` groups',
      detail: 'Several greedy wildcard runs compete for the same characters, multiplying the number of ways to split the input.',
      nodeIds: [],
      suggestion: 'Replace `.*` with a negated class such as `[^\\n]*` or `[^,]*` to remove ambiguity.',
    })
  }

  // 5. Capability notes
  if (requiresBacktracking) {
    findings.push({
      id: 'requires-backtracking',
      severity: 'info',
      title: 'Not expressible as a finite automaton',
      detail:
        'Lookarounds and backreferences cannot be compiled to an NFA, so this pattern can only use the backtracking engine. The safe engine falls back automatically.',
      nodeIds: [],
      suggestion: 'If you can restate the rule without lookarounds (e.g. use capture groups + post-filtering), it becomes linear-time.',
    })
  }

  const unbounded = quantIds.filter((q) => q.max === null)
  if (unbounded.length >= 4) {
    findings.push({
      id: 'many-unbounded',
      severity: 'warn',
      title: `${unbounded.length} unbounded quantifiers`,
      detail: 'Many independent unbounded repetitions widen the search space for a backtracking engine.',
      nodeIds: unbounded.map((q) => q.node.id),
      suggestion: 'Bound the repetition with {n,m} where the domain allows it.',
    })
  }

  if (findings.length === 0 && root) {
    findings.push({
      id: 'ok',
      severity: 'info',
      title: 'No ReDoS-prone shapes detected',
      detail: 'This pattern compiles to a finite automaton and runs in guaranteed linear time on the safe engine.',
      nodeIds: [],
    })
  }

  // --- scoring -------------------------------------------------------------
  let risk = 0
  for (const f of findings) {
    if (f.severity === 'danger') risk += 55
    else if (f.severity === 'warn') risk += 18
  }
  if (starHeight >= 2) risk += 10 * (starHeight - 1)
  if (requiresBacktracking) risk += 15
  risk = Math.min(100, risk)

  const riskLevel: AnalyzeReport['riskLevel'] =
    risk >= 70 ? 'critical' : risk >= 45 ? 'high' : risk >= 20 ? 'medium' : 'low'

  return {
    nodeCount,
    maxDepth,
    starHeight,
    captureGroups,
    distinctClasses: classes.size,
    requiresBacktracking,
    riskScore: risk,
    riskLevel,
    findings,
    automatonComplexity: `O(n · m) — n=${'{'}input.length{'}'}, m=${nodeCount || 1} states`,
  }
}

function firstConsuming(node: AstNode): AstNode | null {
  if (node.type === 'concat' || node.type === 'alternation') {
    for (const c of node.children) {
      const hit = firstConsuming(c)
      if (hit) return hit
    }
    return null
  }
  if (node.type === 'group' || node.type === 'lookaround') return firstConsuming(node.children[0])
  if (node.type === 'quantifier') return node
  return node
}

function hasAnchorBefore(root: AstNode, target: AstNode): boolean {
  let found = false
  let seen = false
  forEachNode(root, (n) => {
    if (n === target) {
      seen = true
      return
    }
    if (!seen && n.type === 'anchor' && (n.kind === '^' || n.kind === '\\b')) found = true
  })
  return found
}

function firstCharKey(node: AstNode): string {
  if (node.type === 'char') return `c:${node.value}`
  if (node.type === 'charClass') return `k:${node.items.map((i) => (i.kind === 'shorthand' ? i.shorthand : i.from)).join('')}`
  if (node.type === 'shorthand') return `s:${node.shorthand}`
  if (node.type === 'group' || node.type === 'quantifier') return firstCharKey(node.children[0])
  if (node.type === 'concat') {
    for (const c of node.children) {
      const k = firstCharKey(c)
      if (k) return k
    }
  }
  return ''
}
