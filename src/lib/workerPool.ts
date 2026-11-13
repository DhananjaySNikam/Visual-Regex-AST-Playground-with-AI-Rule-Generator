/**
 * Hard-deadline worker pool.
 *
 * A single dedicated Worker would be blocked by a catastrophic pattern, so each
 * job gets a deadline: on expiry the worker is `terminate()`d (the only reliable
 * way to stop a tight JS loop) and a fresh one is spawned for the next job.
 */
import type { WorkerRequest, WorkerResponse } from './protocol'

export type WorkerJob =
  | Omit<Extract<WorkerRequest, { type: 'match' }>, 'id'>
  | Omit<Extract<WorkerRequest, { type: 'analyze' }>, 'id'>
  | Omit<Extract<WorkerRequest, { type: 'nodeMatches' }>, 'id'>

type Resolver = {
  resolve: (v: WorkerResponse) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class WorkerPool {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, Resolver>()
  private spawnCount = 0

  constructor(
    private workerFactory: () => Worker,
    private defaultTimeoutMs = 2500,
  ) {}

  get respawns() {
    return this.spawnCount
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = this.workerFactory()
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(e.data.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(e.data.id)
      pending.resolve(e.data)
    }
    w.onerror = (e) => {
      const err = new Error(e.message || 'Worker crashed')
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      this.reset()
    }
    this.worker = w
    this.spawnCount++
    return w
  }

  run(job: WorkerJob, timeoutMs = this.defaultTimeoutMs): Promise<WorkerResponse> {
    const id = this.nextId++
    const worker = this.ensure()
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Hard kill: the worker may be stuck in an uninterruptible loop.
        this.reset()
        reject(new Error(`Timed out after ${timeoutMs}ms — worker terminated`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ ...job, id } as WorkerRequest)
    })
  }

  reset() {
    if (this.worker) {
      this.worker.onmessage = null
      this.worker.onerror = null
      this.worker.terminate()
      this.worker = null
    }
  }

  dispose() {
    for (const [, p] of this.pending) clearTimeout(p.timer)
    this.pending.clear()
    this.reset()
  }
}
