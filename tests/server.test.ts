import { describe, expect, it } from 'vitest'
import { encodeShare, decodeShare, shareIdFor } from '../server/share'
import { execute } from '../server/regexService'
import { localGenerate, reviewPattern, rewriteLinear } from '../server/ai'
import { EXAMPLES } from '../server/examples'

describe('share codec (zstd → base64url → hash)', () => {
  it('round-trips a playground payload', () => {
    const payload = {
      v: 1 as const,
      p: '[A-Z]{5}[0-9]{4}[A-Z]',
      f: 'gm',
      t: 'AAPFU0939F\nCABPM1234K',
      m: 'safe' as const,
      g: { n1: { x: 1, y: 2 } },
    }
    const { code, ratio } = encodeShare(payload)
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(ratio).toBeGreaterThan(1)
    expect(decodeShare(code)).toMatchObject({ p: payload.p, f: 'gm', m: 'safe' })
  })

  it('is deterministic and URL safe', () => {
    const a = encodeShare({ v: 1, p: '\\d+', f: 'g', t: 'x', m: 'safe' })
    const b = encodeShare({ v: 1, p: '\\d+', f: 'g', t: 'x', m: 'safe' })
    expect(a.code).toBe(b.code)
    expect(shareIdFor(a.code)).toHaveLength(12)
  })

  it('rejects garbage without throwing a non-Error', () => {
    expect(() => decodeShare('zzzz')).toThrow(/zstd|Unsupported|Malformed/)
  })
})

describe('server engine', () => {
  it('runs the linear engine and reports complexity', () => {
    const r = execute({ pattern: '\\b[0-9]{3}\\b', input: 'abc 123 4567', flags: 'g', mode: 'safe' })
    expect(r.ok).toBe(true)
    expect(r.matches.map((m) => m.text)).toEqual(['123'])
    expect(r.complexity).toMatch(/O\(n·m\)/)
    expect(r.ast?.type).toBeTruthy()
  })

  it('refuses catastrophic patterns on the backtracking engine', () => {
    const r = execute({ pattern: '(a+)+$', input: 'aaaa!', flags: '', mode: 'backtracking' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/backtracking/i)
  })

  it('refuses lookarounds rather than guessing', () => {
    const r = execute({ pattern: 'a(?=b)', input: 'ab', flags: 'g', mode: 'safe' })
    expect(r.ok).toBe(false)
    expect(r.unsupported.length).toBeGreaterThan(0)
  })

  it('caps the corpus size', () => {
    const r = execute({ pattern: 'a', input: 'a'.repeat(1_100_000), flags: 'g', mode: 'safe' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/1 MiB/)
  })
})

describe('local AI rule compiler', () => {
  it('recognises GST numbers', () => {
    const rule = localGenerate({ prompt: 'match valid Indian GST numbers' })
    expect(rule.pattern).toContain('[A-Z]{5}')
    expect(rule.risk.riskLevel).toBe('low')
    expect(rule.nodes).not.toBeNull()
  })

  it('recognises several domain shapes', () => {
    const prompts: Array<[string, RegExp]> = [
      ['extract email addresses', /@/],
      ['find IPv4 addresses', /25\[0-5\]/],
      ['validate PAN numbers', /\[A-Z\]\{5\}/],
      ['indian pin code please', /\[1-9\]/],
      ['uuid v4 ids', /\[89ab\]/],
    ]
    for (const [prompt, matcher] of prompts) {
      expect(localGenerate({ prompt }).pattern).toMatch(matcher)
    }
  })

  it('composes start/end rules from prose', () => {
    const rule = localGenerate({ prompt: 'starts with INV- and ends with 2024' })
    expect(rule.pattern).toMatch(/^INV-/)
    expect(rule.pattern).toMatch(/2024$/)
  })

  it('is offline and fast', () => {
    const started = performance.now()
    for (let i = 0; i < 50; i++) localGenerate({ prompt: 'match valid Indian GST numbers' })
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('rewrite + review', () => {
  it('rewrites a nested quantifier into a linear form', () => {
    expect(rewriteLinear('(a+)+$')).toBe('a+$')
    expect(rewriteLinear('(\\w+)+')).toBe('\\w+')
    expect(rewriteLinear('\\d{2}')).toBeNull()
  })

  it('explains the risk of a vulnerable pattern', async () => {
    const review = await reviewPattern('(a+)+$', '')
    expect(review.severity).toBe('high')
    expect(review.optimized?.pattern).toBe('a+$')
    expect(review.optimized!.riskAfter.riskScore).toBeLessThan(90)
  })
})

describe('curated examples', () => {
  it('all examples execute cleanly on the linear engine', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(8)
    for (const ex of EXAMPLES) {
      const r = execute({ pattern: ex.pattern, input: ex.corpus, flags: ex.flags, mode: 'safe' })
      expect(r.ok, `${ex.id}: ${r.error}`).toBe(true)
      expect(r.report.riskLevel).not.toBe('critical')
      // Every example except the deliberate ReDoS demo must produce matches.
      if (ex.id !== 'redos') {
        expect(r.matches.length, `${ex.id} should match something`).toBeGreaterThan(0)
      }
    }
  })

  it('the ReDoS example terminates instantly on the linear engine', () => {
    const ex = EXAMPLES.find((e) => e.id === 'redos')!
    const started = performance.now()
    const r = execute({ pattern: ex.pattern, input: ex.corpus, flags: ex.flags, mode: 'safe' })
    expect(performance.now() - started).toBeLessThan(500)
    expect(r.report.riskLevel).toMatch(/high|critical/)
  })
})
