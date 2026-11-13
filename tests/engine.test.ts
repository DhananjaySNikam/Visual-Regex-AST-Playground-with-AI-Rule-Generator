import { describe, expect, it } from 'vitest'
import { parsePattern, compile, runPikeVm, analyzePattern, runMatch, nodeAtOffset } from '../shared/regex/index'

const texts = (pattern: string, input: string, flags = 'g') =>
  runMatch({ pattern, input, flags, mode: 'safe' }).matches.map((m) => m.text)

describe('parser', () => {
  it('records spans that map back to the source', () => {
    const { root, error } = parsePattern('^(ab|c)+$')
    expect(error).toBeNull()
    expect(root).not.toBeNull()
    // root is a concat: [^, quantifier, $]
    const q = root!.children[1]
    expect(q.type).toBe('quantifier')
    expect('^(ab|c)+$'.slice(q.srcStart, q.srcEnd)).toBe('(ab|c)+')
  })

  it('supports named groups and lookarounds', () => {
    const named = parsePattern('(?<year>\\d{4})')
    expect(named.error).toBeNull()
    const look = parsePattern('a(?=b)')
    expect(look.error).toBeNull()
    expect(look.root!.children[1].type).toBe('lookaround')
  })

  it('reports a position for syntax errors', () => {
    const { error } = parsePattern('a(b')
    expect(error?.message).toMatch(/Unterminated group/)
    expect(error?.index).toBe(1)
  })

  it('parses character classes with ranges and shorthand unions', () => {
    const { root } = parsePattern('[a-z0-9_\\s]')
    const cls = root as Extract<typeof root, { type: 'charClass' }>
    expect(cls.type).toBe('charClass')
    expect(cls.items.length).toBe(4)
  })
})

describe('Pike VM (linear engine)', () => {
  const cases: Array<[string, string, string, string[]]> = [
    ['\\b\\w+@\\w+\\.\\w{2,}\\b', 'mail a@b.co and c@d.io', 'g', ['a@b.co', 'c@d.io']],
    ['[^\\s]+', 'hello world', 'g', ['hello', 'world']],
    ['a+', 'aaaa', 'g', ['aaaa']],
    ['a+?', 'aaaa', 'g', ['a', 'a', 'a', 'a']],
    ['a{2,3}', 'aaaaa', 'g', ['aaa', 'aa']],
    ['(\\w+),(\\w+)', 'a,b c,d', 'g', ['a,b', 'c,d']],
    ['colou?r', 'color colour', 'gi', ['color', 'colour']],
    ['^[0-9]{2}[A-Z]{5}$', '27AAPFU', '', ['27AAPFU']],
    ['a.b', 'a\nb', 'g', []],
    ['a.b', 'a\nb', 'gs', ['a\nb']],
    ['\\bcat\\b', 'cat concat cat', 'g', ['cat', 'cat']],
    ['(?:ab)+', 'ababab x', 'g', ['ababab']],
    ['x|y', 'zyx', 'g', ['y', 'x']],
  ]

  it.each(cases)('matches %s', (pattern, input, flags, expected) => {
    expect(texts(pattern, input, flags)).toEqual(expected)
  })

  it('captures groups including named ones', () => {
    const r = runMatch({ pattern: '(?<y>\\d{4})-(?<m>\\d{2})', input: 'on 2024-05', flags: 'g', mode: 'safe' })
    expect(r.matches[0].groups[1]).toBe('2024')
    expect(r.matches[0].groupsNamed?.y).toBe('2024')
    expect(r.matches[0].groupsNamed?.m).toBe('05')
  })

  it('never takes exponential time on catastrophic patterns', () => {
    const evil = 'a'.repeat(40_000) + '!'
    const started = performance.now()
    const res = runMatch({ pattern: '(a+)+$', input: evil, flags: '', mode: 'safe' })
    const elapsed = performance.now() - started
    expect(res.matches).toHaveLength(0)
    expect(elapsed).toBeLessThan(3000)
    // Steps stay proportional to input length × program size, not exponential.
    expect(res.stats.steps).toBeLessThan(evils(evil.length))
  })

  it('stops when the step budget is exhausted', () => {
    const program = compile(parsePattern('(a+)+$').root!, '')
    const res = runPikeVm(program, 'a'.repeat(5000), '', 500)
    expect(res.timedOut).toBe(true)
  })

  it('can be executed twice without state leaking', () => {
    const program = compile(parsePattern('a+b').root!, 'g')
    expect(runPikeVm(program, 'aab ab', 'g').matches).toHaveLength(2)
    expect(runPikeVm(program, 'aab ab', 'g').matches).toHaveLength(2)
  })
})

function evils(n: number) {
  return n * 64
}

describe('analysis', () => {
  it('flags nested quantifiers as high risk', () => {
    const r = analyzePattern('(a+)+$').report
    expect(r.riskLevel).toBe('high')
    expect(r.findings.some((f) => f.id === 'nested-quantifier')).toBe(true)
  })

  it('reports a safe pattern as low risk', () => {
    const r = analyzePattern('^[A-Z]{5}[0-9]{4}[A-Z]$').report
    expect(r.riskLevel).toBe('low')
    expect(r.starHeight).toBe(1)
  })

  it('marks lookarounds as requiring backtracking', () => {
    expect(analyzePattern('a(?=b)').report.requiresBacktracking).toBe(true)
  })
})

describe('reverse mapping', () => {
  it('finds the innermost node at an offset', () => {
    const { root } = parsePattern('^(ab|c)+$')
    const node = nodeAtOffset(root, 2)!
    expect(node.type).toBe('char')
    expect('^(ab|c)+$'.slice(node.srcStart, node.srcEnd)).toBe('a')

    const group = nodeAtOffset(root, 1)!
    expect(group.type).toBe('group')
  })
})
