/// <reference lib="webworker" />
/**
 * Engine worker.
 *
 * Everything expensive happens here: parsing, NFA compilation, Pike-VM matching,
 * static risk analysis and (for the deliberate ReDoS demo) native backtracking.
 *
 * The main thread enforces a HARD deadline by terminating this worker and
 * respawning it — a busy JS loop cannot be interrupted cooperatively, so killing
 * the thread is the only guarantee that the UI never freezes.
 */
import { runMatch, analyzePattern } from '../../shared/regex/index'
import type { WorkerRequest, WorkerResponse } from '../lib/protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  scope.postMessage(msg, transfer ?? [])
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  try {
    switch (req.type) {
      case 'match': {
        const result = runMatch({
          pattern: req.pattern,
          input: req.input,
          flags: req.flags,
          mode: req.mode,
          maxSteps: req.maxSteps,
        })
        post({ id: req.id, type: 'match', result })
        break
      }
      case 'analyze': {
        post({ id: req.id, type: 'analyze', result: analyzePattern(req.pattern, req.flags) })
        break
      }
      case 'nodeMatches': {
        // Run one AST node's own source fragment over the corpus so hovering a
        // node can illuminate *its* substrings, not just the whole match.
        const result = runMatch({
          pattern: req.fragment,
          input: req.input,
          flags: req.flags,
          mode: 'safe',
          maxSteps: req.maxSteps,
        })
        post({
          id: req.id,
          type: 'nodeMatches',
          result: { spans: result.matches.map((m) => [m.start, m.end] as [number, number]), error: result.error },
        })
        break
      }
      case 'ping':
        post({ id: req.id, type: 'pong' })
        break
      default: {
        const unknown = req as { id: number; type: string }
        post({ id: unknown.id, type: 'error', error: `Unknown request ${unknown.type}` })
      }
    }
  } catch (err) {
    post({ id: req.id, type: 'error', error: (err as Error).message })
  }
}
