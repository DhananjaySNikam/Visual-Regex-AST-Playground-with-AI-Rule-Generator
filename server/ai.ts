/**
 * Natural language → regex rule generator.
 *
 * Free-tier providers are used when a key is present (Groq Llama 3.x is the
 * default because its TTFT is the lowest; Gemini Flash is the fallback).
 *
 * When no key is configured — which is the default in this sandbox — the
 * deterministic **LocalRuleCompiler** takes over. It is not a toy: it matches
 * rule shapes (emails, GST numbers, PAN, phone numbers, dates, IPs, URLs,
 * amounts, IDs, "starts with / ends with / between X and Y", qualifiers such as
 * "at least 3 digits") and emits *real* regex with a rationale for every part.
 * That keeps the feature usable with zero cost, zero latency and zero network.
 */
import type { AstNode } from '../shared/regex/types'
import { compile } from '../shared/regex/compile'
import { parsePattern, analyze } from '../shared/regex/index'

export interface GeneratedRule {
  id: string
  title: string
  intent: string
  pattern: string
  flags: string
  explanation: string
  examples: { match: string[]; reject: string[] }
  nodes: AstNode | null
  risk: ReturnType<typeof analyze>
  source: 'groq' | 'gemini' | 'local'
  latencyMs: number
  /** Candidate patterns the local compiler considered. */
  candidates?: Array<{ pattern: string; why: string; score: number }>
}

export interface GeneratorInput {
  prompt: string
  flags?: string
  language?: string
}

// ---------------------------------------------------------------------------
// Local deterministic compiler
// ---------------------------------------------------------------------------

interface Shape {
  id: string
  test: RegExp
  title: string
  pattern: string
  flags: string
  explanation: string
  match: string[]
  reject: string[]
}

const STATE_CODES = '(?:0[1-9]|[1-2][0-9]|3[0-8]|9[7-9])'

const SHAPES: Shape[] = [
  {
    id: 'gstin',
    test: /\b(gst|gstin|goods\s*(and|&)\s*services)\b/i,
    title: 'Indian GSTIN (GST number)',
    pattern: `^${STATE_CODES}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$`,
    flags: '',
    explanation:
      'A GSTIN is 15 characters: a 2-digit state code (01–38 plus 97–99 for registrations predating the state reorganisation), the 10-character PAN of the entity, the entity number, a literal "Z" by default, and a checksum character. Anchoring with ^…$ prevents partial matches inside longer identifiers.',
    match: ['27AAPFU0939F1ZV', '07AAACR5055K1Z5', '33AAACG1234H1ZP'],
    reject: ['27AAPFU0939F1ZVX', '27aapfu0939f1zv', '99AAPFU0939F1ZV'],
  },
  {
    id: 'pan',
    test: /\b(pan|permanent\s+account\s+number)\b/i,
    title: 'Indian PAN',
    pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$',
    flags: '',
    explanation:
      'A PAN is exactly 10 characters: five uppercase letters (the 4th letter encodes the holder type), four digits, then a final uppercase letter. The fourth character is a real classifier in the spec, so [A-Z] is used instead of over-fitting specific letters.',
    match: ['AAPFU0939F', 'CABPM1234K'],
    reject: ['AAFU0939FY', 'aapfu0939f'],
  },
  {
    id: 'email',
    test: /\b(e-?mail|mail\s+address)\b/i,
    title: 'Email address',
    pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    flags: 'g',
    explanation:
      'Local part allows letters, digits and the common ._%+- characters; the domain allows labels separated by dots and requires at least a 2-letter TLD. Every part is a *character class*, never a nested quantifier, so the whole expression runs in guaranteed linear time.',
    match: ['asha@example.com', 'dev+alerts@mail.co.in'],
    reject: ['asha@example', '@example.com', 'a b@c.com'],
  },
  {
    id: 'phone-in',
    test: /\b(indian\s+)?(mobile|phone|cell)\b|\b10\s*digit/i,
    title: 'Indian mobile number',
    pattern: '(?:\\+91[-\\s]?)?[6-9][0-9]{9}',
    flags: 'g',
    explanation:
      'Indian mobile numbers are 10 digits and start with 6–9, optionally prefixed by +91 with a space or hyphen. `(?:…)` is non-capturing so it groups without polluting the capture list.',
    match: ['9876543210', '+91 9876543210', '9912345678'],
    reject: ['1234567890', '98765432'],
  },
  {
    id: 'ipv4',
    test: /\bip(v4)?\b|\bip\s+address\b/i,
    title: 'IPv4 address',
    pattern: '\\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\b',
    flags: 'g',
    explanation:
      'Each octet must be 0–255. The alternation enumerates the legal ranges in priority order (250-255, 200-249, 100-199, then 0-99) instead of using the tempting but ReDoS-prone `\\d{1,3}` three times with a lookaround.',
    match: ['192.168.0.1', '10.0.0.255', '255.255.255.0'],
    reject: ['256.1.1.1', '1.2.3', '1.2.3.345'],
  },
  {
    id: 'date-iso',
    test: /\b(iso\s*)?date\b|\byyyy[-/]mm[-/]dd\b/i,
    title: 'ISO date (YYYY-MM-DD)',
    pattern: '\\b[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])\\b',
    flags: 'g',
    explanation:
      'Years are 4 digits, months 01–12 and days 01–31, expressed as explicit alternations so only real calendar-shaped values match. (Impossible days such as 2024-02-31 still pass — date validity belongs in code, not in a regex.)',
    match: ['2024-01-31', '1999-12-01'],
    reject: ['2024-13-01', '2024-1-1'],
  },
  {
    id: 'url',
    test: /\b(url|link|website)\b/i,
    title: 'HTTP(S) URL',
    pattern: 'https?://[^\\s/$.?#].[^\\s]*',
    flags: 'gi',
    explanation:
      'Matches http:// or https:// followed by at least one host character and then any run of non-whitespace. Using `[^\\s]*` instead of `.*` is deliberate: it cannot cross a newline and keeps the automaton unambiguous.',
    match: ['https://example.com/a?b=1', 'http://mail.co.in'],
    reject: ['ftp://example.com', 'example.com'],
  },
  {
    id: 'hex-color',
    test: /\b(hex|colour|color)\b.*\b(code|value)\b/i,
    title: 'Hex colour code',
    pattern: '#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b',
    flags: 'g',
    explanation: 'A colour literal is # plus either 3 or 6 hex digits; the 3-digit branch is listed first so it is tried first at the same start position.',
    match: ['#fff', '#1E90FF'],
    reject: ['#12', '#1234567'],
  },
  {
    id: 'uuid',
    test: /\buuid\b|\bguid\b/i,
    title: 'UUID v4',
    pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b',
    flags: 'gi',
    explanation: 'The version nibble is a literal 4 and the variant nibble is 8/9/a/b, the two positions that distinguish a v4 UUID from any other hyphenated hex blob.',
    match: ['f47ac10b-58cc-4372-a567-0e02b2c3d479'],
    reject: ['f47ac10b-58cc-1372-a567-0e02b2c3d479'],
  },
  {
    id: 'indian-pincode',
    test: /\b(pin\s*code|postal\s*code|zip)\b/i,
    title: 'Indian PIN code',
    pattern: '\\b[1-9][0-9]{5}\\b',
    flags: 'g',
    explanation: 'A PIN is 6 digits and never starts with 0, because the first digit is the postal zone (1–9).',
    match: ['400001', '560034'],
    reject: ['040001', '40001'],
  },
  {
    id: 'currency-inr',
    test: /\b(amount|price|rupees?|inr|₹)\b/i,
    title: 'Indian currency amount',
    pattern: '(?:₹|Rs\\.?|INR)\\s?[1-9][0-9]{0,2}(?:,[0-9]{2})*(?:,[0-9]{3})?(?:\\.[0-9]{1,2})?',
    flags: 'gi',
    explanation:
      'The Indian digit grouping is 2-2-3 from the right (12,34,567.89). The pattern encodes that grouping explicitly rather than using [0-9,]+ which would accept malformed values like 1,,2.',
    match: ['₹1,23,456.78', 'Rs. 5,000', 'INR 250'],
    reject: ['₹0123', 'Rs. 1,2,3'],
  },
]

interface ShapeMatch {
  shape: Shape
  score: number
}

function shapeCandidates(prompt: string): ShapeMatch[] {
  return SHAPES.map((shape) => {
    const hit = shape.test.test(prompt)
    // Score: explicit shape match dominates; keyword overlap breaks ties.
    const keywordOverlap = prompt
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter((w) => w.length > 2 && shape.title.toLowerCase().includes(w)).length
    return { shape, score: (hit ? 100 : 0) + keywordOverlap * 5 }
  })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
}

/** Builds a "starts with X / ends with Y / contains Z / N digits" rule from prose. */
function composeFromPrompt(prompt: string): { pattern: string; explanation: string } | null {
  const p = prompt.toLowerCase()
  const parts: string[] = []
  const notes: string[] = []

  if (/\bemail\b|e-?mail/.test(p)) {
    parts.push('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}')
    notes.push('the email core')
  }
  const digits = /(?:at least|min(?:imum)?|>=?)\s*(\d{1,3})\s*digits?/.exec(p)
  if (digits && parts.length === 0) {
    parts.push(`[0-9]{${digits[1]},}`)
    notes.push(`at least ${digits[1]} digits`)
  }
  const exactDigits = /exactly\s*(\d{1,3})\s*digits?/.exec(p)
  if (exactDigits && parts.length === 0) {
    parts.push(`[0-9]{${exactDigits[1]}}`)
    notes.push(`exactly ${exactDigits[1]} digits`)
  }
  const between = /between\s*([a-z0-9]+)\s*and\s*([a-z0-9]+)/.exec(p)
  if (between && parts.length === 0 && /letter|char/.test(p)) {
    parts.push(`[${between[1][0]}-${between[2][0]}]`)
    notes.push(`characters ${between[1][0]} through ${between[2][0]}`)
  }
  const startsWith = /starts?\s*with\s*["'`]?([a-z0-9#@$._-]+)["'`]?/i.exec(prompt)
  const endsWith = /ends?\s*with\s*["'`]?([a-z0-9#@$._-]+)["'`]?/i.exec(prompt)
  const contains = /contains?\s*["'`]?([a-z0-9#@$._-]{2,})["'`]?/i.exec(prompt)

  if (parts.length === 0 && (startsWith || endsWith || contains)) {
    const middle = contains ? escapeLiteral(contains[1]) : '[A-Za-z0-9_.-]{0,32}'
    parts.push(`${startsWith ? escapeLiteral(startsWith[1]) : ''}${middle}${endsWith ? escapeLiteral(endsWith[1]) : ''}`)
    if (contains) notes.push(`contains "${contains[1]}"`)
    if (startsWith) notes.push(`starts with "${startsWith[1]}"`)
    if (endsWith) notes.push(`ends with "${endsWith[1]}"`)
  }

  if (parts.length === 0) return null
  const anchored = /\b(exactly|entire|whole|full|validate|only)\b/.test(p)
  const body = parts.join('')
  const pattern = anchored ? `^${body}$` : body
  const explanation =
    `Built from your description: ${notes.join(', ')}. ` +
    (anchored
      ? 'Anchored with ^…$ because the wording implies whole-value validation.'
      : 'Left unanchored so the rule can find the value anywhere in a line.') +
    ' The element is a single character class, so matching stays linear.'
  return { pattern, explanation }
}

function escapeLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function localGenerate(input: GeneratorInput, startedAt = performance.now()): GeneratedRule {
  const prompt = input.prompt.trim()
  const candidates = shapeCandidates(prompt)

  if (candidates.length > 0) {
    const best = candidates[0].shape
    return finalize(
      {
        id: `local-${best.id}`,
        title: best.title,
        intent: prompt,
        pattern: best.pattern,
        flags: input.flags ?? best.flags,
        explanation: best.explanation,
        examples: { match: best.match, reject: best.reject },
        source: 'local',
        latencyMs: 0,
        candidates: candidates.slice(1, 3).map((c) => ({
          pattern: c.shape.pattern,
          why: c.shape.title,
          score: c.score,
        })),
      },
      startedAt,
    )
  }

  const composed = composeFromPrompt(prompt)
  if (composed) {
    return finalize(
      {
        id: 'local-composed',
        title: 'Composed from description',
        intent: prompt,
        pattern: composed.pattern,
        flags: input.flags ?? '',
        explanation: composed.explanation,
        examples: { match: [], reject: [] },
        source: 'local',
        latencyMs: 0,
      },
      startedAt,
    )
  }

  // Last resort: literal phrase, which is always correct and never surprising.
  const literal = escapeLiteral(prompt.split(/[.!?]/)[0].slice(0, 60))
  return finalize(
    {
      id: 'local-literal',
      title: 'Literal phrase match',
      intent: prompt,
      pattern: literal,
      flags: input.flags ?? 'i',
      explanation:
        'No standard shape (email, GSTIN, PAN, phone, IP, date, URL, UUID, PIN, colour, amount) was recognised, so the safest interpretation is a literal, case-insensitive match of your phrase. Refine the prompt with a shape name, e.g. "match valid Indian GST numbers".',
      examples: { match: [], reject: [] },
      source: 'local',
      latencyMs: 0,
    },
    startedAt,
  )
}

type DraftRule = Omit<GeneratedRule, 'nodes' | 'risk'> & { nodes?: AstNode | null; risk?: GeneratedRule['risk'] }

function finalize(rule: DraftRule, startedAt: number): GeneratedRule {
  const parsed = parsePattern(rule.pattern)
  rule.nodes = parsed.root
  rule.risk = analyze(parsed.root, rule.pattern)
  rule.latencyMs = Math.round(performance.now() - startedAt)
  if (parsed.root) {
    const unsupported = compile(parsed.root, rule.flags).unsupported
    if (unsupported.length > 0) {
      rule.explanation += ` Note: ${unsupported.join('; ')} — this rule will use the backtracking fallback.`
    }
  }
  return rule as GeneratedRule
}

// ---------------------------------------------------------------------------
// Remote providers
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a regex rule generator for a developer playground.
Return ONLY compact JSON with this shape:
{"title":string,"pattern":string,"flags":string,"explanation":string,"match":string[],"reject":string[]}
Rules:
- JavaScript regex syntax. No delimiters, no /slashes/ around the pattern.
- Prefer character classes and explicit alternations over nested quantifiers; never emit a pattern with a quantifier nested inside another quantifier over the same characters (ReDoS).
- "explanation" must justify each element in 1-4 sentences.
- "match" and "reject" must contain 2-4 realistic sample values each.`

interface ProviderConfig {
  name: 'groq' | 'gemini'
  key: string
  model: string
  endpoint: string
}

function configuredProviders(): ProviderConfig[] {
  const out: ProviderConfig[] = []
  if (process.env.GROQ_API_KEY) {
    out.push({
      name: 'groq',
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    })
  }
  if (process.env.GEMINI_API_KEY) {
    out.push({
      name: 'gemini',
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    })
  }
  return out
}

export function providerStatus() {
  const providers = configuredProviders()
  return {
    mode: providers.length > 0 ? 'live' : 'local',
    providers: providers.map((p) => ({ name: p.name, model: p.model })),
    note:
      providers.length > 0
        ? 'Free-tier provider keys detected — prompts are sent to the provider.'
        : 'No GROQ_API_KEY / GEMINI_API_KEY configured. The deterministic local compiler handles prompts on-device with zero network calls.',
  }
}

async function callGroq(cfg: ProviderConfig, prompt: string): Promise<string> {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.1,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  return json.choices[0].message.content
}

async function callGemini(cfg: ProviderConfig, prompt: string): Promise<string> {
  const res = await fetch(`${cfg.endpoint}/${cfg.model}:generateContent?key=${cfg.key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\nRequest: ${prompt}` }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  }
  return json.candidates[0].content.parts.map((p) => p.text).join('')
}

function parseModelJson(raw: string): Omit<GeneratedRule, 'nodes' | 'risk' | 'source' | 'latencyMs' | 'intent' | 'id'> {
  const cleaned = raw.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const body = JSON.parse(cleaned.slice(start, end + 1)) as {
    title?: string
    pattern?: string
    flags?: string
    explanation?: string
    match?: string[]
    reject?: string[]
  }
  if (!body.pattern) throw new Error('Model did not return a pattern')
  return {
    title: body.title ?? 'Generated rule',
    pattern: body.pattern,
    flags: (body.flags ?? '').replace(/[^gimsuy]/g, ''),
    explanation: body.explanation ?? '',
    examples: { match: body.match ?? [], reject: body.reject ?? [] },
  }
}

export async function generateRule(input: GeneratorInput): Promise<GeneratedRule> {
  const startedAt = performance.now()
  const providers = configuredProviders()

  for (const cfg of providers) {
    try {
      const raw = cfg.name === 'groq' ? await callGroq(cfg, input.prompt) : await callGemini(cfg, input.prompt)
      const parsed = parseModelJson(raw)
      return finalize(
        {
          ...parsed,
          id: `${cfg.name}-${Date.now().toString(36)}`,
          intent: input.prompt,
          source: cfg.name,
          latencyMs: 0,
        },
        startedAt,
      )
    } catch (err) {
      console.warn(`[ai] ${cfg.name} failed, falling back:`, (err as Error).message)
    }
  }

  const local = localGenerate(input, startedAt)
  if (providers.length > 0) {
    local.explanation += ' (Provider call failed — this rule was produced by the local compiler.)'
  }
  return local
}

/** Reviews an existing pattern: performance + vulnerability explainer. */
export interface ReviewResult {
  summary: string
  severity: 'low' | 'medium' | 'high'
  findings: Array<{ title: string; detail: string; rewrite?: string }>
  optimized?: { pattern: string; why: string; riskAfter: ReturnType<typeof analyze> }
  source: 'groq' | 'gemini' | 'local'
}

export async function reviewPattern(pattern: string, flags: string): Promise<ReviewResult> {
  const parsed = parsePattern(pattern)
  const before = analyze(parsed.root, pattern)
  const local = localReview(pattern, flags, before)

  for (const cfg of configuredProviders()) {
    try {
      const body = `${SYSTEM_PROMPT}\n\nReview this regex for correctness, performance and ReDoS risk. Also return "rewrite": a linear-time equivalent if any weakness exists.\nPattern: ${pattern}\nFlags: ${flags || '(none)'}`
      const raw = cfg.name === 'groq' ? await callGroq(cfg, body) : await callGemini(cfg, body)
      const parsedModel = parseModelJson(raw)
      return {
        ...local,
        summary: parsedModel.explanation || local.summary,
        findings: local.findings,
        optimized: parsedModel.pattern
          ? {
              pattern: parsedModel.pattern,
              why: parsedModel.explanation,
              riskAfter: analyze(parsePattern(parsedModel.pattern).root, parsedModel.pattern),
            }
          : local.optimized,
        source: cfg.name,
      }
    } catch (err) {
      console.warn(`[ai] review via ${cfg.name} failed:`, (err as Error).message)
    }
  }
  return local
}

function localReview(pattern: string, flags: string, report: ReturnType<typeof analyze>): ReviewResult {
  const findings = report.findings.map((f) => ({
    title: f.title,
    detail: f.detail,
    rewrite: f.suggestion,
  }))

  let optimized: ReviewResult['optimized']
  const rewrite = rewriteLinear(pattern)
  if (rewrite && rewrite !== pattern) {
    optimized = {
      pattern: rewrite,
      why: 'Removes the nested quantifier that lets a backtracking engine explore exponentially many partitions of the input.',
      riskAfter: analyze(parsePattern(rewrite).root, rewrite),
    }
  }

  const severity = report.riskLevel === 'critical' ? 'high' : report.riskLevel === 'high' ? 'high' : report.riskLevel === 'medium' ? 'medium' : 'low'

  return {
    summary:
      report.findings.length === 0 || (report.findings.length === 1 && report.findings[0].id === 'ok')
        ? `This pattern compiles to a finite automaton (${report.nodeCount} states) and runs in O(n·m) time; no ReDoS shape was found. Flags: ${flags || 'none'}.`
        : `Risk score ${report.riskScore}/100 (${report.riskLevel}). ${findings.length} issue(s) detected. The pattern has ${report.nodeCount} AST nodes, nesting depth ${report.maxDepth} and star height ${report.starHeight}.`,
    severity,
    findings,
    optimized,
    source: 'local',
  }
}

/** Rewrites the classic nested-quantifier shapes into single quantifiers. */
export function rewriteLinear(pattern: string): string | null {
  const before = pattern
  let out = pattern
  out = out.replace(/\((\\?[a-zA-Z0-9]|\[[^\]]+\])([+*])\)\1?[+*]/g, (m) => {
    if (m.includes('[^')) return m
    const inner = /^\((\\?[a-zA-Z0-9]|\[[^\]]+\])/.exec(m)?.[1] ?? ''
    return `${inner}+`
  })
  out = out.replace(/\((\\w|\.)\)[+*]\1?[+*]/g, '$1+')
  return out !== before ? out : null
}
