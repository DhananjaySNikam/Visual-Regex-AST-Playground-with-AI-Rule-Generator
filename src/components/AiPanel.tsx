import { useCallback, useEffect, useRef, useState } from 'react'
import type { GeneratedRule, ReviewResult } from '../lib/api'
import { api, type ProviderStatus } from '../lib/api'
import type { AnalyzeReport } from '../../shared/regex/types'

interface AiPanelProps {
  pattern: string
  flags: string
  onApply: (pattern: string, flags: string, corpus?: string) => void
  report: AnalyzeReport | null
  riskLevel: string
}

const SUGGESTIONS = [
  'match valid Indian GST numbers',
  'extract Indian mobile numbers with +91',
  'Email addresses for an audit log',
  'find IPv4 addresses in nginx logs',
  'UUID v4 request ids',
  'INR amounts in lakh format',
  'starts with INV- and ends with 2024',
  'at least 6 digits',
]

export function AiPanel({ pattern, flags, onApply, report, riskLevel }: AiPanelProps) {
  const [prompt, setPrompt] = useState('match valid Indian GST numbers')
  const [loading, setLoading] = useState(false)
  const [rule, setRule] = useState<GeneratedRule | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [review, setReview] = useState<ReviewResult | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    api
      .health()
      .then((h) => setStatus(h.ai))
      .catch(() => setStatus(null))
  }, [])

  const generate = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.generate(prompt)
      if (id === requestId.current) setRule(res.rule)
    } catch (err) {
      if (id === requestId.current) setError((err as Error).message)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [prompt])

  const reviewPattern = useCallback(async () => {
    if (!pattern) return
    setReviewing(true)
    setError(null)
    try {
      const res = await api.review(pattern, flags)
      setReview(res.review)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setReviewing(false)
    }
  }, [pattern, flags])

  return (
    <div className="panel ai-panel">
      <header className="panel-head">
        <div className="panel-title">
          <span className="dot dot-violet" />
          AI rule generator
          <span className={`pill ${status?.mode === 'live' ? 'pill-live' : 'pill-local'}`}>
            {status ? (status.mode === 'live' ? status.providers.map((p) => p.name).join(' + ') : 'local compiler') : 'offline'}
          </span>
        </div>
      </header>

      <div className="ai-body">
        <div className="ai-input-row">
          <textarea
            className="ai-input"
            value={prompt}
            rows={2}
            placeholder="Describe the rule in plain English…"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate()
            }}
          />
          <button type="button" className="primary ai-go" onClick={() => void generate()} disabled={loading || prompt.trim().length === 0}>
            {loading ? 'Generating…' : 'Generate'}
            <span className="kbd">⌘↵</span>
          </button>
        </div>

        <div className="ai-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setPrompt(s)}>
              {s}
            </button>
          ))}
        </div>

        {status?.mode !== 'live' && status && (
          <p className="ai-note">
            No <code>GROQ_API_KEY</code>/<code>GEMINI_API_KEY</code> configured — prompts are compiled by the deterministic
            local rule compiler (instant, offline, zero cost). Add a key to <code>.env</code> to route them to Llama 3 / Gemini Flash.
          </p>
        )}

        {error && <div className="error-box">{error}</div>}

        {rule && (
          <article className="rule-card">
            <div className="rule-head">
              <h3>{rule.title}</h3>
              <span className="pill pill-dim">{rule.source} · {rule.latencyMs}ms</span>
            </div>
            <code className="rule-pattern">{rule.pattern}</code>
            <p className="rule-explain">{rule.explanation}</p>

            {rule.examples.match.length > 0 && (
              <div className="rule-examples">
                <div>
                  <span className="label label-ok">matches</span>
                  {rule.examples.match.map((m) => (
                    <code key={m} className="ex ex-ok">{m}</code>
                  ))}
                </div>
                <div>
                  <span className="label label-no">rejects</span>
                  {rule.examples.reject.map((m) => (
                    <code key={m} className="ex ex-no">{m}</code>
                  ))}
                </div>
              </div>
            )}

            <div className="rule-actions">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  onApply(
                    rule.pattern,
                    rule.flags,
                    rule.examples.match.length ? rule.examples.match.join('\n') : undefined,
                  )
                }
              >
                Load into playground
              </button>
              {rule.candidates && rule.candidates.length > 0 && (
                <div className="rule-candidates">
                  {rule.candidates.map((c) => (
                    <button key={c.pattern} type="button" className="chip" onClick={() => onApply(c.pattern, flags)} title={c.pattern}>
                      {c.why}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </article>
        )}

        <div className="ai-review">
          <div className="ai-review-head">
            <h3>Performance &amp; vulnerability explainer</h3>
            <button type="button" className="ghost" onClick={() => void reviewPattern()} disabled={reviewing || !pattern}>
              {reviewing ? 'Analysing…' : 'Analyse current pattern'}
            </button>
          </div>
          {report && (
            <div className="risk-summary">
              <RiskMeter score={report.riskScore} level={riskLevel} />
              <ul>
                <li><span>AST nodes</span><b>{report.nodeCount}</b></li>
                <li><span>Nesting depth</span><b>{report.maxDepth}</b></li>
                <li><span>Star height</span><b>{report.starHeight}</b></li>
                <li><span>Automaton</span><b>{report.requiresBacktracking ? 'needs backtracking' : 'linear NFA'}</b></li>
              </ul>
            </div>
          )}
          {review && (
            <div className="review-card">
              <p className={`review-summary sev-${review.severity}`}>{review.summary}</p>
              <ul className="review-findings">
                {review.findings.map((f, i) => (
                  <li key={`${f.title}-${i}`}>
                    <strong>{f.title}</strong>
                    <p>{f.detail}</p>
                    {f.rewrite && <code className="rewrite">→ {f.rewrite}</code>}
                  </li>
                ))}
              </ul>
              {review.optimized && (
                <div className="optimized">
                  <span className="label label-ok">O(n) rewrite</span>
                  <code className="rule-pattern">{review.optimized.pattern}</code>
                  <p>{review.optimized.why}</p>
                  <div className="optimized-meta">
                    risk {review.optimized.riskAfter.riskScore} → {review.optimized.riskAfter.riskLevel}
                    <button type="button" className="chip" onClick={() => onApply(review.optimized!.pattern, flags)}>
                      Apply rewrite
                    </button>
                  </div>
                </div>
              )}
              <span className="pill pill-dim">explained by {review.source}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function RiskMeter({ score, level }: { score: number; level: string }) {
  return (
    <div className={`risk-meter risk-${level}`}>
      <div className="risk-gauge">
        <div className="risk-fill" style={{ width: `${Math.max(3, score)}%` }} />
      </div>
      <div className="risk-labels">
        <span className="risk-score">{score}</span>
        <span className="risk-level">{level}</span>
      </div>
    </div>
  )
}
