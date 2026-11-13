/**
 * UI smoke test.
 *
 * Monaco and React Flow are replaced with lightweight shims (they need canvas /
 * layout APIs jsdom does not implement), while everything else — the hook, the
 * worker facade, the graph projection, the panels — runs for real. This catches
 * the class of bugs that a type-check cannot: bad hooks order, undefined props,
 * render-time crashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'

// --- Monaco shim ------------------------------------------------------------
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, onMount }: { value: string; onChange: (v: string) => void; onMount?: (e: unknown, m: unknown) => void }) => {
    const editor = {
      onDidChangeCursorPosition: () => ({ dispose() {} }),
      createDecorationsCollection: () => ({ set() {} }),
      getModel: () => ({ getValueLength: () => value.length, getPositionAt: () => ({ lineNumber: 1, column: 1 }), getOffsetAt: () => 0 }),
      revealRangeInCenterIfOutsideViewport: () => {},
      focus: () => {},
    }
    const monaco = {
      editor: {
        defineTheme: () => {},
        setTheme: () => {},
        setModelMarkers: () => {},
        OverviewRulerLane: { Center: 1 },
      },
      MarkerSeverity: { Error: 8 },
      Range: class {},
      languages: {
        register: () => {},
        setMonarchTokensProvider: () => {},
        setLanguageConfiguration: () => {},
      },
    }
    onMount?.(editor, monaco)
    return createElement('textarea', { 'data-testid': 'monaco', value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) })
  },
}))

// --- React Flow shim -------------------------------------------------------
vi.mock('@xyflow/react', () => {
  const passthrough = (name: string) => (props: Record<string, unknown>) =>
    createElement('div', { 'data-testid': name }, props.children as never)
  return {
    ReactFlow: ({
      nodes,
      onNodeClick,
    }: {
      nodes: Array<{ id: string; data: { ast: { label: string; id: string } } }>
      onNodeClick?: (e: unknown, n: unknown) => void
    }) =>
      createElement(
        'div',
        { 'data-testid': 'reactflow' },
        nodes.map((n) =>
          createElement(
            'button',
            {
              key: n.id,
              'data-testid': `node-${n.id}`,
              onClick: () => onNodeClick?.({}, n),
            },
            n.data.ast.label,
          ),
        ),
      ),
    ReactFlowProvider: passthrough('provider'),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    BackgroundVariant: { Dots: 'dots' },
    useNodesState: (initial: unknown[]) => [initial, () => {}, () => {}],
    useEdgesState: (initial: unknown[]) => [initial, () => {}, () => {}],
    useReactFlow: () => ({ fitView: () => {} }),
  }
})

// --- Worker shim: runs the real engine synchronously ----------------------
vi.mock('../src/lib/workerPool', async () => {
  const engine = await import('../shared/regex/index')
  class FakePool {
    respawns = 1
    async run(job: Record<string, unknown> & { type: string }) {
      if (job.type === 'match') {
        const j = job as unknown as { pattern: string; input: string; flags: string; mode: 'safe' | 'backtracking' }
        return { id: 1, type: 'match', result: engine.runMatch(j) }
      }
      if (job.type === 'analyze') {
        const j = job as unknown as { pattern: string; flags: string }
        return { id: 2, type: 'analyze', result: engine.analyzePattern(j.pattern, j.flags) }
      }
      return { id: 3, type: 'nodeMatches', result: { spans: [], error: null } }
    }
    dispose() {}
  }
  return { WorkerPool: FakePool }
})

const health = {
  ok: true,
  uptimeMs: 1,
  node: 'v22',
  engine: 'linear-nfa (Pike VM)',
  store: { kind: 'sqlite', ttlHours: 24, entries: 0, expired: 0, bytes: 0 },
  ai: { mode: 'local', providers: [], note: '' },
  architecture: { time: 'O(n·m)', space: 'stateless' },
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/health')) return new Response(JSON.stringify(health), { status: 200 })
      if (String(url).includes('/api/examples')) return new Response(JSON.stringify({ examples: [] }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }),
  )
  window.location.hash = ''
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App shell', () => {
  it('renders the playground and shows match results from the engine', async () => {
    const { default: App } = await import('../src/App')
    render(createElement(App))

    expect(screen.getByText('Regex Atlas')).toBeTruthy()
    expect(screen.getByText('Pattern')).toBeTruthy()
    expect(screen.getByText('AST graph')).toBeTruthy()
    expect(screen.getByText('Test corpus')).toBeTruthy()

    // The default GST rule matches the valid GSTINs in the seeded corpus, and
    // those substrings are illuminated in the corpus view.
    await waitFor(
      () => {
        expect(document.querySelectorAll('.match-table tbody tr').length).toBeGreaterThan(2)
        expect(document.querySelectorAll('.seg-match').length).toBeGreaterThan(2)
      },
      { timeout: 4000 },
    )

    const status = document.querySelector('.statusbar')?.textContent ?? ''
    expect(status).toMatch(/O\(n·m\) guaranteed/)
    expect(status).toMatch(/AST nodes/)

    // AST nodes are projected into the graph.
    await waitFor(() => {
      expect(screen.getByTestId('reactflow').children.length).toBeGreaterThan(3)
    })
  })

  it('offers the safe engine by default and the risk report', async () => {
    const { default: App } = await import('../src/App')
    render(createElement(App))
    expect(screen.getByText('Safe · linear')).toBeTruthy()
    expect(screen.getByText('Backtracking')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText(/ReDoS risk/i).length).toBeGreaterThan(0))
  })
})
