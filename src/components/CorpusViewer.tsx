import { useMemo } from 'react'

export interface CorpusViewerProps {
  text: string
  onChange: (t: string) => void
  matches: Array<{ start: number; end: number; groups: (string | undefined)[] }>
  /** Spans produced by the hovered node's own sub-pattern. */
  nodeSpans: Array<[number, number]>
  activeNodeId: string | null
  editable: boolean
  onToggleEditable: () => void
}

interface Segment {
  text: string
  start: number
  kind: 'plain' | 'match' | 'node'
  groupIndex?: number
}

function buildSegments(
  text: string,
  matches: CorpusViewerProps['matches'],
  nodeSpans: Array<[number, number]>,
): Segment[] {
  const boundaries = new Set<number>([0, text.length])
  for (const m of matches) {
    boundaries.add(m.start)
    boundaries.add(m.end)
  }
  for (const [s, e] of nodeSpans) {
    boundaries.add(s)
    boundaries.add(e)
  }
  const points = [...boundaries].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b)

  const inMatch = (pos: number) => matches.findIndex((m) => pos >= m.start && pos < m.end)
  const inNode = (pos: number) => nodeSpans.some(([s, e]) => pos >= s && pos < e)

  const out: Segment[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]
    const end = points[i + 1]
    if (end <= start) continue
    const chunk = text.slice(start, end)
    const mi = inMatch(start)
    const ni = inNode(start)
    out.push({
      text: chunk,
      start,
      kind: ni ? 'node' : mi >= 0 ? 'match' : 'plain',
      groupIndex: mi,
    })
  }
  return out
}

/**
 * The test corpus.
 *
 * Every match is tinted; the spans belonging to the hovered AST node are lifted
 * to full brightness with an animated underline. Rendering is a single flat list
 * of spans (no nested wrappers) so 5 000 matches stay smooth.
 */
export function CorpusViewer({
  text,
  onChange,
  matches,
  nodeSpans,
  activeNodeId,
  editable,
  onToggleEditable,
}: CorpusViewerProps) {
  const segments = useMemo(() => buildSegments(text, matches, nodeSpans), [text, matches, nodeSpans])
  const hasNodeSpans = nodeSpans.length > 0
  const lines = text.split('\n').length

  return (
    <div className="panel corpus-panel">
      <header className="panel-head">
        <div className="panel-title">
          <span className="dot dot-green" />
          Test corpus
          <span className="panel-count">{matches.length} match{matches.length === 1 ? '' : 'es'}</span>
        </div>
        <div className="panel-actions">
          <span className="mono-dim">{lines} lines · {text.length} chars</span>
          <button type="button" className={`chip ${editable ? 'is-on' : ''}`} onClick={onToggleEditable}>
            {editable ? 'editing' : 'edit'}
          </button>
        </div>
      </header>
      <div className="corpus-body">
        {editable ? (
          <textarea
            className="corpus-textarea"
            value={text}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            placeholder="Paste the text you want to test against…"
          />
        ) : text.length === 0 ? (
          <div className="corpus-empty">
            <p>No corpus yet.</p>
            <button type="button" className="link" onClick={onToggleEditable}>
              Paste some text
            </button>
          </div>
        ) : (
          <pre className="corpus-pre" aria-label="match highlights">
            {segments.map((seg, i) => {
              const classes = ['seg', `seg-${seg.kind}`]
              if (seg.kind === 'match' && hasNodeSpans) classes.push('seg-muted')
              return (
                <span
                  key={`${seg.start}-${i}`}
                  className={classes.join(' ')}
                  data-offset={seg.start}
                  data-node-active={activeNodeId ?? undefined}
                  style={
                    seg.kind !== 'plain' && seg.groupIndex !== undefined && seg.groupIndex % 2 === 1
                      ? { ['--seg-alt' as string]: '1' }
                      : undefined
                  }
                >
                  {seg.text}
                </span>
              )
            })}
          </pre>
        )}
      </div>
    </div>
  )
}
