import { useMemo, useState } from 'react'
import type { MatchSpan } from '../../shared/regex/types'

interface MatchTableProps {
  matches: MatchSpan[]
  activeId: string | null
  corpus: string
}

const PAGE = 200

export function MatchTable({ matches, activeId, corpus }: MatchTableProps) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const rows = useMemo(() => matches.slice(0, PAGE), [matches])
  const lineOf = useMemo(() => {
    const starts: number[] = [0]
    for (let i = 0; i < corpus.length; i++) if (corpus[i] === '\n') starts.push(i + 1)
    return (offset: number) => {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= offset) lo = mid
        else hi = mid - 1
      }
      return { line: lo + 1, column: offset - starts[lo] + 1 }
    }
  }, [corpus])

  return (
    <div className="panel match-panel">
      <header className="panel-head">
        <div className="panel-title">
          <span className="dot dot-amber" />
          Matches
          <span className="panel-count">{matches.length}{matches.length > PAGE ? ` (showing ${PAGE})` : ''}</span>
        </div>
        {activeId && <span className="pill pill-dim">node {activeId}</span>}
      </header>
      <div className="match-body">
        {rows.length === 0 ? (
          <p className="empty-note">No matches in the corpus yet.</p>
        ) : (
          <table className="match-table">
            <thead>
              <tr>
                <th>#</th>
                <th>match</th>
                <th>line:col</th>
                <th>span</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => {
                const pos = lineOf(m.start)
                const isOpen = expanded === i
                return (
                  <tr key={`${m.start}-${i}`} className={isOpen ? 'is-open' : ''} onClick={() => setExpanded(isOpen ? null : i)}>
                    <td className="num">{i + 1}</td>
                    <td className="match-cell">
                      <code title={m.text}>{m.text === '' ? <em>(empty)</em> : m.text.length > 48 ? m.text.slice(0, 48) + '…' : m.text}</code>
                      {isOpen && m.groups.length > 1 && (
                        <ul className="group-list">
                          {m.groups.slice(1).map((g, gi) => (
                            <li key={gi}>
                              <code>${gi + 1}</code> {g === undefined ? <em>undefined</em> : g || <em>(empty)</em>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="num mono-dim">
                      {pos.line}:{pos.column}
                    </td>
                    <td className="num mono-dim">
                      {m.start}–{m.end}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
