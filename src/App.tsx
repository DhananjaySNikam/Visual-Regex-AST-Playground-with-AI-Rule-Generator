import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { AstGraph } from './components/AstGraph'
import { PatternEditor } from './components/PatternEditor'
import { CorpusViewer } from './components/CorpusViewer'
import { NodeBuilder } from './components/NodeBuilder'
import { AiPanel, RiskMeter } from './components/AiPanel'
import { Inspector } from './components/Inspector'
import { MatchTable } from './components/MatchTable'
import { ShareDialog } from './components/ShareDialog'
import { usePlayground } from './hooks/usePlayground'
import { api, type Example, type HealthResponse } from './lib/api'
import { compileBlocks } from './lib/builder'

const FLAG_OPTIONS: Array<{ f: string; label: string }> = [
  { f: 'g', label: 'global' },
  { f: 'i', label: 'ignore case' },
  { f: 'm', label: 'multiline' },
  { f: 's', label: 'dotAll' },
  { f: 'u', label: 'unicode' },
  { f: 'y', label: 'sticky' },
]

export default function App() {
  const pg = usePlayground()
  const [examples, setExamples] = useState<Example[]>([])
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [showBuilder, setShowBuilder] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [corpusEditable, setCorpusEditable] = useState(false)
  const [aside, setAside] = useState<'inspector' | 'ai'>('inspector')
  const [serverCheck, setServerCheck] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void api.examples().then((r) => setExamples(r.examples)).catch(() => setExamples([]))
    void api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  const toggleFlag = useCallback(
    (f: string) => {
      const has = pg.flags.includes(f)
      pg.setFlags(has ? pg.flags.replace(f, '') : pg.flags + f)
    },
    [pg],
  )

  const loadExample = useCallback(
    (ex: Example) => {
      pg.applyRule(ex.pattern, ex.flags, ex.corpus)
    },
    [pg],
  )

  const verifyOnServer = useCallback(async () => {
    setServerCheck({ ok: true, text: 'Running on the linear engine…' })
    try {
      const res = await api.serverRun(pg.pattern, pg.corpus, pg.flags)
      setServerCheck({
        ok: res.ok,
        text: res.ok
          ? `Server agrees · ${res.elapsedMicros}µs · ${res.matches.length} matches · ${res.complexity}`
          : `Server rejected: ${res.error}`,
      })
    } catch (err) {
      setServerCheck({ ok: false, text: (err as Error).message })
    }
  }, [pg.pattern, pg.corpus, pg.flags])

  const builderPreview = useMemo(() => compileBlocks(pg.blocks).pattern, [pg.blocks])

  const riskLevel = pg.report?.riskLevel ?? 'low'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="26" height="26">
              <circle cx="9" cy="9" r="4" fill="none" stroke="#22d3ee" strokeWidth="2" />
              <circle cx="23" cy="23" r="4" fill="none" stroke="#a78bfa" strokeWidth="2" />
              <path d="M12 11 L20 21" stroke="#475569" strokeWidth="2" />
              <path d="M14 23 C 18 23, 18 9, 22 9" stroke="#f472b6" strokeWidth="1.6" fill="none" strokeDasharray="3 3" />
            </svg>
          </div>
          <div>
            <h1>Regex Atlas</h1>
            <p>Visual regex &amp; AST playground</p>
          </div>
        </div>

        <div className="examples">
          <select
            aria-label="Load an example"
            value=""
            onChange={(e) => {
              const ex = examples.find((x) => x.id === e.target.value)
              if (ex) loadExample(ex)
            }}
          >
            <option value="">Load example…</option>
            {examples.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.title}
              </option>
            ))}
          </select>
        </div>

        <div className="topbar-right">
          <span className={`engine-chip ${pg.mode === 'safe' ? 'is-safe' : 'is-danger'}`}>
            {pg.busy ? 'running…' : pg.stats?.engine ?? pg.mode}
          </span>
          <button type="button" className="ghost" onClick={() => setShowBuilder(true)}>
            Node builder
          </button>
          <button type="button" className="ghost" onClick={() => setShowShare(true)}>
            Share
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="pane pane-pattern">
          <div className="panel pattern-panel">
            <header className="panel-head">
              <div className="panel-title">
                <span className="dot dot-cyan" />
                Pattern
                {pg.parse?.error && <span className="pill pill-error">syntax error</span>}
              </div>
              <div className="flags">
                {FLAG_OPTIONS.map((opt) => (
                  <button
                    key={opt.f}
                    type="button"
                    className={`flag ${pg.flags.includes(opt.f) ? 'is-on' : ''}`}
                    onClick={() => toggleFlag(opt.f)}
                    title={opt.label}
                  >
                    {opt.f}
                  </button>
                ))}
              </div>
            </header>
            <div className={`pattern-editor${pg.parse?.error ? ' has-error' : ''}`}>
              <span className="slash">/</span>
              <div className="editor-host">
                <PatternEditor
                  value={pg.pattern}
                  onChange={pg.setPattern}
                  highlight={pg.highlight}
                  error={pg.parse?.error ?? null}
                  onCursorOffset={pg.cursorToNode}
                />
              </div>
              <span className="slash slash-end">/{pg.flags}</span>
            </div>
            <div className="engine-bar">
              <div className="engine-switch">
                <button
                  type="button"
                  className={pg.mode === 'safe' ? 'is-on' : ''}
                  onClick={() => pg.setMode('safe')}
                  title="Thompson NFA / Pike VM: guaranteed O(n·m)"
                >
                  Safe · linear
                </button>
                <button
                  type="button"
                  className={pg.mode === 'backtracking' ? 'is-on is-danger' : ''}
                  onClick={() => pg.setMode('backtracking')}
                  title="Naive backtracking: may take exponential time (runs under a hard kill-deadline)"
                >
                  Backtracking
                </button>
              </div>
              <div className="engine-stats">
                <span><b>{pg.stats?.elapsedMs ?? 0}</b> ms</span>
                <span><b>{pg.stats?.steps ?? 0}</b> steps</span>
                <span className="mono-dim">{pg.stats?.complexity ?? '—'}</span>
              </div>
            </div>
            {pg.engineError && <div className="error-box error-inline">{pg.engineError}</div>}
            {pg.stats?.fallbackReason && !pg.engineError && (
              <div className="warn-box error-inline">
                Safe engine fell back to backtracking: {pg.stats.fallbackReason}
              </div>
            )}
          </div>

          <div className="panel inspector-panel">
            <Inspector
              node={pg.activeNode}
              root={pg.root}
              matches={pg.matches}
              pinned={!!pg.pinnedId}
              onSelect={pg.setPinnedId}
              onClear={() => {
                pg.setPinnedId(null)
                pg.setHoverId(null)
              }}
            />
          </div>
        </section>

        <section className="pane pane-graph">
          <div className="panel graph-panel">
            <header className="panel-head">
              <div className="panel-title">
                <span className="dot dot-violet" />
                AST graph
                <span className="panel-count">{pg.report?.nodeCount ?? 0} nodes</span>
                {pg.pinnedId && <span className="pill pill-dim">pinned</span>}
              </div>
              <div className="panel-actions">
                <span className="mono-dim hint">hover a node to light up its token &amp; matches</span>
              </div>
            </header>
            <div className="graph-host">
              <ReactFlowProvider>
                <AstGraph
                  root={pg.root}
                  collapsed={pg.collapsed}
                  overrides={pg.overrides}
                  activeId={pg.activeId}
                  pinnedId={pg.pinnedId}
                  nodeMatches={pg.nodeMatches}
                  pattern={pg.pattern}
                  onHover={pg.setHoverId}
                  onToggleCollapse={pg.toggleCollapse}
                  onSelect={pg.setPinnedId}
                  onPin={pg.setPinnedId}
                  onMoveNode={pg.moveNode}
                  onRelayout={pg.relayout}
                />
              </ReactFlowProvider>
              {!pg.root && (
                <div className="graph-empty">
                  <p>{pg.parse?.error ? pg.parse.error.message : 'Type a pattern to see its AST'}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="pane pane-right">
          <div className="panel-tabs">
            <button type="button" className={aside === 'inspector' ? 'is-on' : ''} onClick={() => setAside('inspector')}>
              Analysis
            </button>
            <button type="button" className={aside === 'ai' ? 'is-on' : ''} onClick={() => setAside('ai')}>
              AI
            </button>
          </div>

          <div className="pane-right-body">
            {aside === 'inspector' ? (
              <>
                <div className="panel risk-panel">
                  <header className="panel-head">
                    <div className="panel-title">
                      <span className="dot dot-rose" />
                      ReDoS risk
                    </div>
                    <span className={`pill pill-${riskLevel}`}>{riskLevel}</span>
                  </header>
                  <div className="risk-body">
                    <RiskMeter score={pg.report?.riskScore ?? 0} level={riskLevel} />
                    <ul className="meta-list">
                      <li><span>Nesting depth</span><b>{pg.report?.maxDepth ?? 0}</b></li>
                      <li><span>Star height</span><b>{pg.report?.starHeight ?? 0}</b></li>
                      <li><span>Capture groups</span><b>{pg.report?.captureGroups ?? 0}</b></li>
                      <li><span>Automaton</span><b>{pg.report?.requiresBacktracking ? 'backtracking only' : 'finite (linear)'}</b></li>
                    </ul>
                    <ul className="findings">
                      {(pg.report?.findings ?? []).map((f) => (
                        <li key={f.id} className={`finding sev-${f.severity}`}>
                          <strong>{f.title}</strong>
                          <p>{f.detail}</p>
                          {f.suggestion && <code>→ {f.suggestion}</code>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <MatchTable matches={pg.matches} activeId={pg.activeId} corpus={pg.corpus} />

                <div className="panel backend-panel">
                  <header className="panel-head">
                    <div className="panel-title">
                      <span className="dot dot-green" />
                      Backend
                    </div>
                    {health?.store && (
                      <span className="pill pill-dim">
                        {health.store.kind} · {health.store.ttlHours}h TTL
                      </span>
                    )}
                  </header>
                  <div className="backend-body">
                    <ul className="meta-list">
                      <li><span>Engine</span><b>{health?.engine ?? 'offline'}</b></li>
                      <li><span>AI mode</span><b>{health?.ai?.mode ?? 'local'}</b></li>
                      <li><span>Stored shares</span><b>{health?.store?.entries ?? 0}</b></li>
                      <li><span>Worker restarts</span><b>{pg.stats?.workerRestarts ?? 0}</b></li>
                    </ul>
                    <button type="button" className="ghost wide" onClick={() => void verifyOnServer()}>
                      Re-validate on server (linear engine)
                    </button>
                    {serverCheck && (
                      <p className={`server-check ${serverCheck.ok ? 'ok' : 'bad'}`}>{serverCheck.text}</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <AiPanel
                pattern={pg.pattern}
                flags={pg.flags}
                report={pg.report}
                riskLevel={riskLevel}
                onApply={(pattern, flags, corpus) => pg.applyRule(pattern, flags, corpus)}
              />
            )}
          </div>
        </section>

        <section className="pane pane-corpus">
          <CorpusViewer
            text={pg.corpus}
            onChange={pg.setCorpus}
            matches={pg.matches}
            nodeSpans={pg.nodeSpans}
            activeNodeId={pg.activeId}
            editable={corpusEditable}
            onToggleEditable={() => setCorpusEditable((v) => !v)}
          />
        </section>
      </div>

      <footer className="statusbar">
        <span>
          <b>{pg.matches.length}</b> matches
        </span>
        <span>
          <b>{pg.report?.nodeCount ?? 0}</b> AST nodes
        </span>
        <span className="mono-dim">{pg.pattern.length} chars · corpus {pg.corpus.length} chars</span>
        <span className="spacer" />
        <span className={`mode-indicator ${pg.mode}`}>{pg.mode === 'safe' ? 'O(n·m) guaranteed' : 'exponential risk'}</span>
        {builderPreview && (
          <button type="button" className="link" onClick={() => setShowBuilder(true)}>
            builder: <code>{builderPreview.slice(0, 28)}</code>
          </button>
        )}
      </footer>

      {showBuilder && (
        <NodeBuilder
          blocks={pg.blocks}
          onChange={pg.setBlocks}
          onClose={() => setShowBuilder(false)}
          onApply={(pattern) => {
            pg.applyRule(pattern, pg.flags)
            setShowBuilder(false)
          }}
        />
      )}

      {showShare && (
        <ShareDialog
          payload={{ p: pg.pattern, f: pg.flags, t: pg.corpus, m: pg.mode, g: pg.overrides }}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  )
}
