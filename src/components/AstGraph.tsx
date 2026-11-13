import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AstNode } from '../../shared/regex/types'
import { findNode } from '../../shared/regex/parser'
import { buildGraph, FLAVOR_COLORS, type AstFlowEdge, type AstFlowNode, type LayoutOverride } from '../lib/graph'
import { AstNodeCard } from './AstNodeCard'
import { GraphContextProvider } from '../lib/graphContext'

const nodeTypes = { ast: AstNodeCard }

export interface AstGraphProps {
  root: AstNode | null
  collapsed: Set<string>
  overrides: LayoutOverride
  activeId: string | null
  pinnedId: string | null
  nodeMatches: Record<string, number>
  pattern: string
  onHover: (id: string | null) => void
  onToggleCollapse: (id: string) => void
  onSelect: (id: string) => void
  onPin: (id: string | null) => void
  onMoveNode: (id: string, pos: { x: number; y: number }) => void
  onRelayout: () => void
}

function Inner({
  root,
  collapsed,
  overrides,
  activeId,
  pinnedId,
  nodeMatches,
  pattern,
  onHover,
  onToggleCollapse,
  onSelect,
  onPin,
  onMoveNode,
  onRelayout,
}: AstGraphProps) {
  const graph = useMemo(
    () => buildGraph(root, collapsed, overrides, activeId, nodeMatches, pattern),
    [root, collapsed, overrides, activeId, nodeMatches, pattern],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState<AstFlowNode>(graph.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<AstFlowEdge>(graph.edges)
  const { fitView } = useReactFlow()
  const prevRootId = useRef<string | null>(null)
  const prevCount = useRef(0)

  // Re-project the AST whenever the pattern (or interaction state) changes.
  useEffect(() => {
    setNodes(graph.nodes)
    setEdges(graph.edges)
    const rootId = root?.id ?? null
    if (rootId !== prevRootId.current || graph.nodes.length !== prevCount.current) {
      prevRootId.current = rootId
      prevCount.current = graph.nodes.length
      const t = setTimeout(() => fitView({ padding: 0.22, duration: 320, maxZoom: 1.05 }), 40)
      return () => clearTimeout(t)
    }
    return undefined
  }, [graph, setNodes, setEdges, fitView, root?.id])

  const handleNodeClick = useCallback<NodeMouseHandler<AstFlowNode>>(
    (_e, node) => {
      onSelect(node.data.ast.id)
      onPin(node.data.ast.id)
    },
    [onSelect, onPin],
  )

  const handleDragStop = useCallback(
    (_e: unknown, node: AstFlowNode) => {
      onMoveNode(node.id, { x: node.position.x, y: node.position.y })
    },
    [onMoveNode],
  )

  const context = useMemo(
    () => ({
      onHover,
      onToggleCollapse,
      onSelect,
      onPin,
    }),
    [onHover, onToggleCollapse, onSelect, onPin],
  )

  return (
    <GraphContextProvider value={context}>
      <ReactFlow<AstFlowNode, AstFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStop={handleDragStop}
        onPaneClick={() => {
          onPin(null)
          onHover(null)
        }}
        onNodeMouseEnter={(_e, node) => onHover(node.data.ast.id)}
        onNodeMouseLeave={() => onHover(null)}
        fitView
        minZoom={0.18}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        className="ast-flow"
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1b2434" />
        <MiniMap
          pannable
          zoomable
          className="ast-minimap"
          nodeColor={(n) => {
            const data = (n as AstFlowNode).data
            return data?.ast ? FLAVOR_COLORS[data.ast.flavor].accent : '#334155'
          }}
          maskColor="rgba(6,10,16,.82)"
        />
        <Controls className="ast-controls" showInteractive={false} />
        <div className="ast-relayout">
          <button type="button" onClick={onRelayout} title="Reset the layout to auto-arrange">
            Auto layout
          </button>
        </div>
        {pinnedId && root && (
          <div className="ast-pinned-hint">
            pinned:&nbsp;<code>{findNode(root, pinnedId)?.label ?? pinnedId}</code>
          </div>
        )}
      </ReactFlow>
    </GraphContextProvider>
  )
}

export function AstGraph(props: AstGraphProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  )
}
