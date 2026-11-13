import type { AstNode, MatchSpan } from '../../shared/regex/types'
import { FLAVOR_COLORS } from '../lib/graph'

interface InspectorProps {
  node: AstNode | null
  root: AstNode | null
  matches: MatchSpan[]
  pinned: boolean
  onSelect: (id: string | null) => void
  onClear: () => void
}

/** Breadcrumb of ancestors, used for orientation inside deep trees. */
function ancestors(root: AstNode | null, id: string): AstNode[] {
  if (!root) return []
  const path: AstNode[] = []
  const walk = (node: AstNode): boolean => {
    path.push(node)
    if (node.id === id) return true
    for (const c of node.children) if (walk(c)) return true
    path.pop()
    return false
  }
  walk(root)
  return path
}

export function Inspector({ node, root, matches, pinned, onSelect, onClear }: InspectorProps) {
  if (!node) {
    return (
      <div className="inspector-empty">
        <h3>Inspector</h3>
        <p>
          Hover a node in the AST graph, or move the cursor inside the pattern editor. The matching token in the editor
          and its substrings in the corpus highlight together.
        </p>
        <ul className="legend">
          {Object.entries(FLAVOR_COLORS).slice(0, 6).map(([flavor, c]) => (
            <li key={flavor}>
              <span className="swatch" style={{ background: c.accent }} />
              {flavor}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const trail = ancestors(root, node.id).slice(0, -1)
  const palette = FLAVOR_COLORS[node.flavor]
  const groups = matches.flatMap((m) =>
    m.groups.map((g, i) => (g ? { i, g } : null)).filter((x): x is { i: number; g: string } => x !== null),
  )
  const uniqueGroups = [...new Map(groups.map((g) => [g.i, g])).values()].slice(0, 12)

  return (
    <div className="inspector">
      <header className="inspector-head">
        {trail.length > 0 && (
          <nav className="crumbs">
            {trail.map((a, i) => (
              <button key={a.id} type="button" onClick={() => onSelect(a.id)} title={a.explain}>
                {i > 0 && <span className="sep">›</span>}
                {a.type === 'group' && a.label.startsWith('capture') ? a.label : a.type}
              </button>
            ))}
          </nav>
        )}
        <div className="inspector-title">
          <span className="swatch-lg" style={{ background: palette.accent, boxShadow: `0 0 18px ${palette.glow}` }} />
          <div>
            <h3 style={{ color: palette.accent }}>{node.label}</h3>
            <code className="inspector-src">{node.type}</code>
          </div>
          {pinned && (
            <button type="button" className="icon-btn" onClick={onClear} title="Unpin">
              ✕
            </button>
          )}
        </div>
      </header>

      <p className="inspector-explain">{node.explain}</p>

      <dl className="inspector-grid">
        <div>
          <dt>source range</dt>
          <dd>{node.srcStart}–{node.srcEnd}</dd>
        </div>
        <div>
          <dt>children</dt>
          <dd>{node.children.length}</dd>
        </div>
        <div>
          <dt>flavor</dt>
          <dd style={{ color: palette.accent }}>{node.flavor}</dd>
        </div>
        <div>
          <dt>matches</dt>
          <dd>{matches.length}</dd>
        </div>
      </dl>

      {uniqueGroups.length > 0 && (
        <div className="inspector-groups">
          <span className="label">captured groups</span>
          <ul>
            {uniqueGroups.map((g) => (
              <li key={g.i}>
                <code>${g.i}</code>
                <span>{g.g.length > 40 ? g.g.slice(0, 40) + '…' : g.g}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
