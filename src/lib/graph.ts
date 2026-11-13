/**
 * AST → React Flow graph projection.
 *
 * Layout is a tidy "fan-out tree": the root sits on the left, children are laid
 * out on the right, and subtrees are stacked so no node ever overlaps. Positions
 * are deterministic, so a shared layout stays stable across reloads, and the
 * user's manual drags are persisted on top of it.
 */
import type { Node, Edge } from '@xyflow/react'
import type { AstNode, Flavor } from '../../shared/regex/types'

export interface AstNodeData extends Record<string, unknown> {
  ast: AstNode
  depth: number
  isCollapsed: boolean
  hasChildren: boolean
  directMatches: number
  isActive: boolean
  isDimmed: boolean
  pattern: string
}

export type AstFlowNode = Node<AstNodeData, 'ast'>
export type AstFlowEdge = Edge<{ active: boolean; label?: string }>

export const FLAVOR_COLORS: Record<Flavor, { accent: string; bg: string; border: string; glow: string }> = {
  literal: { accent: '#7dd3fc', bg: '#0b2233', border: '#1e5f86', glow: 'rgba(125,211,252,.45)' },
  class: { accent: '#fbbf24', bg: '#2a1f06', border: '#7c5a11', glow: 'rgba(251,191,36,.45)' },
  shorthand: { accent: '#f59e0b', bg: '#2a1c05', border: '#7c5311', glow: 'rgba(245,158,11,.4)' },
  group: { accent: '#a78bfa', bg: '#1d1435', border: '#5b3f9e', glow: 'rgba(167,139,250,.45)' },
  quantifier: { accent: '#fb7185', bg: '#2b0f19', border: '#8a2438', glow: 'rgba(251,113,133,.45)' },
  anchor: { accent: '#34d399', bg: '#07231b', border: '#0f6b52', glow: 'rgba(52,211,153,.45)' },
  wildcard: { accent: '#22d3ee', bg: '#062430', border: '#0e6b80', glow: 'rgba(34,211,238,.45)' },
  alternation: { accent: '#f472b6', bg: '#2a0f22', border: '#8b2559', glow: 'rgba(244,114,182,.45)' },
  lookaround: { accent: '#c084fc', bg: '#241033', border: '#6d2b93', glow: 'rgba(192,132,252,.45)' },
  backref: { accent: '#fda4af', bg: '#2b1418', border: '#8b3a44', glow: 'rgba(253,164,175,.45)' },
}

const NODE_W = 208
const GAP_X = 312
const GAP_Y = 108

export interface LayoutOverride {
  [nodeId: string]: { x: number; y: number }
}

export function buildGraph(
  root: AstNode | null,
  collapsed: Set<string>,
  overrides: LayoutOverride,
  activeId: string | null,
  nodeMatches: Record<string, number>,
  pattern: string,
): { nodes: AstFlowNode[]; edges: AstFlowEdge[] } {
  if (!root) return { nodes: [], edges: [] }

  const nodes: AstFlowNode[] = []
  const edges: AstFlowEdge[] = []
  let cursorY = 0

  const layout = (node: AstNode, depth: number): { y: number } => {
    const isCollapsed = collapsed.has(node.id)
    const children = isCollapsed ? [] : node.children
    const x = depth * GAP_X
    let y: number

    if (children.length === 0) {
      y = cursorY
      cursorY += GAP_Y
    } else {
      const ys = children.map((c) => layout(c, depth + 1).y)
      y = (ys[0] + ys[ys.length - 1]) / 2
    }

    const active = activeId === node.id
    const override = overrides[node.id]
    const data: AstNodeData = {
      ast: node,
      depth,
      isCollapsed,
      hasChildren: node.children.length > 0,
      directMatches: nodeMatches[node.id] ?? 0,
      isActive: active,
      isDimmed: activeId !== null && !active && !isAncestorOf(root, activeId, node.id),
      pattern: pattern.slice(node.srcStart, node.srcEnd),
    }

    nodes.push({
      id: node.id,
      type: 'ast',
      position: override ?? { x, y },
      data,
      style: { width: NODE_W },
      draggable: true,
      selectable: true,
      zIndex: active ? 10 : Math.max(1, 20 - depth),
      className: active ? 'ast-node-active' : '',
    })

    for (const child of children) {
      edges.push({
        id: `${node.id}->${child.id}`,
        source: node.id,
        target: child.id,
        type: 'smoothstep',
        animated: active,
        className: active ? 'ast-edge-active' : '',
        style: {
          stroke: active ? '#e2e8f0' : '#2c3a52',
          strokeWidth: active ? 2.2 : 1.4,
        },
        data: { active },
      })
    }

    return { y }
  }

  layout(root, 0)
  return { nodes, edges }
}

function isAncestorOf(root: AstNode, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return true
  const anc = find(root, ancestorId)
  if (!anc) return false
  return !!find(anc, nodeId)
}

function find(node: AstNode, id: string): AstNode | null {
  if (node.id === id) return node
  for (const c of node.children) {
    const hit = find(c, id)
    if (hit) return hit
  }
  return null
}

/** Flattens the AST into reading order (used by the breadcrumb / inspector). */
export function flatten(root: AstNode | null): AstNode[] {
  if (!root) return []
  const out: AstNode[] = []
  const walk = (n: AstNode) => {
    out.push(n)
    n.children.forEach(walk)
  }
  walk(root)
  return out
}
