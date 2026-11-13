/**
 * The playground's single source of truth.
 *
 * Responsibilities:
 *  - debounce + dispatch work to the engine worker (parse, match, analyse)
 *  - keep the forward worker→UI data flow one-way (worker owns nothing)
 *  - translate hover state into the three highlights (graph, editor, corpus)
 *  - persist / restore the whole state through the `#s=` URL hash
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnalyzeReport, AstNode, MatchSpan, ParseResult } from '../../shared/regex/types'
import { findNode, nodeAtOffset } from '../../shared/regex/parser'
import { WorkerPool } from '../lib/workerPool'
import type { LayoutOverride } from '../lib/graph'
import type { Block } from '../lib/builder'

export interface PlaygroundState {
  pattern: string
  flags: string
  corpus: string
  mode: 'safe' | 'backtracking'
}

export interface EngineStats {
  engine: string
  steps: number
  elapsedMs: number
  complexity: string
  timedOut: boolean
  fallbackReason?: string
  workerRestarts: number
}

const DEFAULT_PATTERN = '^(?:0[1-9]|[1-2][0-9]|3[0-8]|9[7-9])[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
const DEFAULT_FLAGS = 'gm'
const DEFAULT_CORPUS = ['27AAPFU0939F1ZV', '07AAACR5055K1Z5', '33AAACG1234H1ZP', '27aapfu0939f1zv', '99AAPFU0939F1ZV', '27AAPFU0939F1Z'].join('\n')

export function usePlayground() {
  const [pattern, setPattern] = useState(DEFAULT_PATTERN)
  const [flags, setFlags] = useState(DEFAULT_FLAGS)
  const [corpus, setCorpus] = useState(DEFAULT_CORPUS)
  const [mode, setMode] = useState<'safe' | 'backtracking'>('safe')

  const [parse, setParse] = useState<ParseResult | null>(null)
  const [matches, setMatches] = useState<MatchSpan[]>([])
  const [report, setReport] = useState<AnalyzeReport | null>(null)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [hoverId, setHoverId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<LayoutOverride>({})
  const [blocks, setBlocks] = useState<Block[]>([])
  const [nodeMatches, setNodeMatches] = useState<Record<string, number>>({})
  const [nodeSpans, setNodeSpans] = useState<Array<[number, number]>>([])

  const poolRef = useRef<WorkerPool | null>(null)
  const matchSeq = useRef(0)
  const restoredRef = useRef(false)

  if (!poolRef.current) {
    poolRef.current = new WorkerPool(() => new Worker(new URL('../workers/engine.worker.ts', import.meta.url), { type: 'module' }), 2500)
  }

  const activeId = hoverId ?? pinnedId
  const root: AstNode | null = parse?.root ?? null
  const activeNode = useMemo(() => (root && activeId ? findNode(root, activeId) : null), [root, activeId])

  // ---- restore from URL hash -------------------------------------------------
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const hash = window.location.hash
    const code = hash.startsWith('#s=') ? hash.slice(3) : null
    if (!code) return
    void import('../lib/api').then(async ({ api }) => {
      try {
        const { payload } = await api.decodeShare(code)
        const p = payload as {
          p?: string
          f?: string
          t?: string
          m?: 'safe' | 'backtracking'
          g?: LayoutOverride
        }
        if (typeof p.p === 'string') setPattern(p.p)
        if (typeof p.f === 'string') setFlags(p.f)
        if (typeof p.t === 'string') setCorpus(p.t)
        if (p.m === 'safe' || p.m === 'backtracking') setMode(p.m)
        if (p.g) setOverrides(p.g)
      } catch (err) {
        setEngineError(`Could not restore shared playground: ${(err as Error).message}`)
      }
    })
  }, [])

  // ---- main engine effect ----------------------------------------------------
  useEffect(() => {
    const pool = poolRef.current!
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      const seq = ++matchSeq.current
      try {
        const res = await Promise.all([
          pool.run({ type: 'match', pattern, input: corpus, flags, mode }, mode === 'backtracking' ? 4000 : 2500),
          pool.run({ type: 'analyze', pattern, flags }, 2000),
        ])
        if (cancelled || seq !== matchSeq.current) return

        const [matchRes, analyzeRes] = res
        if (matchRes.type === 'error') {
          setEngineError(matchRes.error)
        } else if (matchRes.type === 'match') {
          setEngineError(matchRes.result.error && matchRes.result.matches.length === 0 ? matchRes.result.error : null)
          setMatches(matchRes.result.matches)
          setParse(matchRes.result.parse)
          setStats({
            engine: matchRes.result.stats.engine,
            steps: matchRes.result.stats.steps,
            elapsedMs: matchRes.result.stats.elapsedMs,
            complexity: matchRes.result.stats.complexity,
            timedOut: matchRes.result.stats.timedOut,
            fallbackReason: matchRes.result.stats.fallbackReason,
            workerRestarts: pool.respawns - 1,
          })
        }
        if (analyzeRes.type === 'analyze') {
          setReport(analyzeRes.result.report)
        }
      } catch (err) {
        if (cancelled || seq !== matchSeq.current) return
        const message = (err as Error).message
        setEngineError(
          message.includes('Timed out')
            ? 'Engine exceeded its hard deadline and the worker was terminated — this is the guard that keeps catastrophic backtracking from freezing the UI. Switch to the safe engine for a guaranteed linear run.'
            : message,
        )
        setStats((s) =>
          s
            ? { ...s, timedOut: true, workerRestarts: pool.respawns - 1 }
            : {
                engine: mode,
                steps: 0,
                elapsedMs: 0,
                complexity: mode === 'safe' ? 'O(n·m) linear' : 'O(2ⁿ) backtracking',
                timedOut: true,
                workerRestarts: pool.respawns - 1,
              },
        )
      } finally {
        if (!cancelled && seq === matchSeq.current) setBusy(false)
      }
    }, 170)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pattern, corpus, flags, mode])

  // ---- hover → per-node corpus highlight ------------------------------------
  useEffect(() => {
    if (!activeNode || !root) {
      setNodeSpans([])
      return
    }
    let cancelled = false
    const pool = poolRef.current!
    const fragment = pattern.slice(activeNode.srcStart, activeNode.srcEnd)
    if (!fragment) {
      setNodeSpans([])
      return
    }
    // Debounce: sweeping the cursor across the graph should not queue dozens of
    // worker jobs, and only the last hover's result is ever displayed.
    const timer = setTimeout(() => {
      pool
        .run({ type: 'nodeMatches', fragment, input: corpus, flags: flags.replace('y', ''), maxSteps: 400_000 }, 1500)
        .then((res) => {
          if (cancelled || res.type !== 'nodeMatches') return
          // Zero-width nodes (anchors) would "match" at every offset; they are
          // better represented by the node card than by 5 000 corpus spans.
          const spans = res.result.spans.filter(([a, b]) => b > a).slice(0, 4000)
          setNodeSpans(spans)
          setNodeMatches((prev) => ({ ...prev, [activeNode.id]: spans.length }))
        })
        .catch(() => {})
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeNode, root, pattern, corpus, flags])

  // ---- reverse sync: editor cursor → graph node -----------------------------
  const cursorToNode = useCallback(
    (offset: number) => {
      if (!root) return
      const node = nodeAtOffset(root, offset)
      setHoverId(node ? node.id : null)
    },
    [root],
  )

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const moveNode = useCallback((id: string, pos: { x: number; y: number }) => {
    setOverrides((prev) => ({ ...prev, [id]: pos }))
  }, [])

  const relayout = useCallback(() => {
    setOverrides({})
    setCollapsed(new Set())
  }, [])

  const applyRule = useCallback((nextPattern: string, nextFlags?: string, nextCorpus?: string) => {
    setPattern(nextPattern)
    if (nextFlags !== undefined) setFlags(nextFlags)
    if (nextCorpus !== undefined) setCorpus(nextCorpus)
    setPinnedId(null)
    setHoverId(null)
    setOverrides({})
    setCollapsed(new Set())
  }, [])

  const state: PlaygroundState = { pattern, flags, corpus, mode }

  const highlight = useMemo(() => {
    if (!activeNode) return null
    return { start: activeNode.srcStart, end: activeNode.srcEnd }
  }, [activeNode])

  useEffect(() => () => poolRef.current?.dispose(), [])

  return {
    // state
    pattern,
    flags,
    corpus,
    mode,
    parse,
    root,
    matches,
    report,
    stats,
    engineError,
    busy,
    activeId,
    activeNode,
    pinnedId,
    collapsed,
    overrides,
    blocks,
    nodeMatches,
    nodeSpans,
    highlight,
    state,
    // setters
    setPattern,
    setFlags,
    setCorpus,
    setMode,
    setHoverId,
    setPinnedId,
    setBlocks,
    setEngineError,
    // actions
    cursorToNode,
    toggleCollapse,
    moveNode,
    relayout,
    applyRule,
  }
}

export type Playground = ReturnType<typeof usePlayground>
