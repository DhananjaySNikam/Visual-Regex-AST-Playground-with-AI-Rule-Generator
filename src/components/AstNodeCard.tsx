import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AstFlowNode } from '../lib/graph'
import { FLAVOR_COLORS } from '../lib/graph'
import { useGraphContext } from '../lib/graphContext'

/**
 * A single AST node in the graph.
 *
 * Hover is the primary interaction: it drives the editor highlight, the corpus
 * highlight and the inspector — all through one callbacks prop.
 */
function AstNodeCardInner({ data, id, selected }: NodeProps<AstFlowNode>) {
  const { onHover, onToggleCollapse } = useGraphContext()
  const { ast, isCollapsed, hasChildren, directMatches, isActive, isDimmed } = data
  const palette = FLAVOR_COLORS[ast.flavor]

  return (
    <div
      className={`ast-card${isActive ? ' is-active' : ''}${isDimmed ? ' is-dimmed' : ''}${selected ? ' is-selected' : ''}`}
      style={{
        borderColor: isActive ? '#f8fafc' : palette.border,
        background: `linear-gradient(160deg, ${palette.bg} 0%, #0a0f18 100%)`,
        boxShadow: isActive
          ? `0 0 0 1.5px ${palette.accent}, 0 10px 34px -8px ${palette.glow}`
          : '0 6px 18px -10px rgba(0,0,0,.9)',
      }}
      data-node-id={id}
      title={ast.explain}
      onMouseEnter={() => onHover(ast.id)}
      onMouseLeave={() => onHover(null)}
      onDoubleClick={() => hasChildren && onToggleCollapse(ast.id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="ast-handle"
        onMouseEnter={() => onHover(ast.id)}
        onMouseLeave={() => onHover(null)}
      />
      <div className="ast-card-head">
        <span className="ast-card-kind" style={{ color: palette.accent }}>
          {ast.type}
        </span>
        <span className="ast-card-range">
          {ast.srcStart}–{ast.srcEnd}
        </span>
      </div>
      <div className="ast-card-label" style={{ color: palette.accent }}>
        {ast.label}
      </div>
      <div className="ast-card-foot">
        <code className="ast-card-src">{truncate(data.pattern, 26)}</code>
        <div className="ast-card-meta">
          {directMatches > 0 && <span className="ast-badge">{directMatches} hit{directMatches === 1 ? '' : 's'}</span>}
          {hasChildren && (
            <span
              className={`ast-collapse ${isCollapsed ? 'is-collapsed' : ''}`}
              title={isCollapsed ? 'Expand subtree' : 'Collapse subtree'}
              onMouseEnter={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onToggleCollapse(ast.id)
              }}
            >
              {isCollapsed ? `+${countDescendants(ast)}` : '−'}
            </span>
          )}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="ast-handle"
        onMouseEnter={() => onHover(ast.id)}
        onMouseLeave={() => onHover(null)}
      />
    </div>
  )
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function countDescendants(node: { children: unknown[] }): number {
  let n = 0
  const walk = (x: { children: unknown[] }) => {
    for (const c of x.children) {
      n++
      walk(c as { children: unknown[] })
    }
  }
  walk(node)
  return n
}

export const AstNodeCard = memo(AstNodeCardInner)
