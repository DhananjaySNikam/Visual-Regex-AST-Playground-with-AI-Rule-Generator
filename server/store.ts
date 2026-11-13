/**
 * Ephemeral storage: SQLite in WAL mode with a 24-hour TTL.
 *
 * * WAL gives us concurrent readers while a writer appends — no lock contention
 *   between the "save" and "load" hot paths.
 * * Every row carries `expires_at`; a lightweight sweeper deletes expired rows,
 *   so storage is bounded by the 24h window rather than growing forever
 *   (the "O(1) space" property: live data is a function of the TTL, not of
 *   total traffic).
 * * The database is optional: if SQLite is unavailable the API transparently
 *   degrades to an in-process LRU with the same TTL semantics.
 */
import { shareIdFor } from './share'

export interface SavedPlayground {
  id: string
  code: string
  createdAt: number
  expiresAt: number
  hits: number
}

export interface Store {
  readonly kind: 'sqlite' | 'memory'
  save(code: string): Promise<SavedPlayground>
  get(id: string): Promise<SavedPlayground | null>
  stats(): Promise<{ entries: number; expired: number; bytes: number }>
  sweep(): Promise<number>
  close(): Promise<void>
}

const TTL_MS = 24 * 60 * 60 * 1000

export class MemoryStore implements Store {
  readonly kind = 'memory' as const
  private map = new Map<string, SavedPlayground>()

  async save(code: string) {
    const now = Date.now()
    const id = shareIdFor(code)
    const existing = this.map.get(id)
    const row: SavedPlayground = existing ?? {
      id,
      code,
      createdAt: now,
      expiresAt: now + TTL_MS,
      hits: 0,
    }
    this.map.set(id, row)
    return row
  }

  async get(id: string) {
    const row = this.map.get(id)
    if (!row) return null
    if (row.expiresAt < Date.now()) {
      this.map.delete(id)
      return null
    }
    row.hits++
    return row
  }

  async stats() {
    const now = Date.now()
    let expired = 0
    let bytes = 0
    for (const row of this.map.values()) {
      if (row.expiresAt < now) expired++
      else bytes += row.code.length
    }
    return { entries: this.map.size - expired, expired, bytes }
  }

  async sweep() {
    const now = Date.now()
    let n = 0
    for (const [id, row] of this.map) {
      if (row.expiresAt < now) {
        this.map.delete(id)
        n++
      }
    }
    return n
  }

  async close() {}
}

export async function openStore(): Promise<Store> {
  try {
    // node:sqlite is built in from Node 22.5 (still flagged experimental).
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(process.env.SQLITE_PATH ?? 'playground.sqlite')
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS shares (
        id         TEXT PRIMARY KEY,
        code       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        hits       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
    `)

    const upsert = db.prepare(
      `INSERT INTO shares (id, code, created_at, expires_at, hits)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at`,
    )
    const select = db.prepare(`SELECT * FROM shares WHERE id = ?`)
    const bump = db.prepare(`UPDATE shares SET hits = hits + 1 WHERE id = ?`)
    const prune = db.prepare(`DELETE FROM shares WHERE expires_at < ?`)
    const aggregate = db.prepare(
      `SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(code)), 0) AS bytes,
              COALESCE(SUM(CASE WHEN expires_at < ? THEN 1 ELSE 0 END), 0) AS expired
       FROM shares`,
    )

    return {
      kind: 'sqlite',
      async save(code: string) {
        const now = Date.now()
        const id = shareIdFor(code)
        const expiresAt = now + TTL_MS
        upsert.run(id, code, now, expiresAt)
        return { id, code, createdAt: now, expiresAt, hits: 0 }
      },
      async get(id: string) {
        const row = select.get(id) as
          | { id: string; code: string; created_at: number; expires_at: number; hits: number }
          | undefined
        if (!row) return null
        if (row.expires_at < Date.now()) {
          prune.run(Date.now())
          return null
        }
        bump.run(id)
        return {
          id: row.id,
          code: row.code,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          hits: row.hits + 1,
        }
      },
      async stats() {
        const row = aggregate.get(Date.now()) as { entries: number; bytes: number; expired: number }
        return {
          entries: Number(row.entries) - Number(row.expired),
          expired: Number(row.expired),
          bytes: Number(row.bytes),
        }
      },
      async sweep() {
        const res = prune.run(Date.now())
        return Number(res.changes ?? 0)
      },
      async close() {
        db.close()
      },
    }
  } catch (err) {
    console.warn('[store] SQLite unavailable, falling back to in-memory store:', (err as Error).message)
    return new MemoryStore()
  }
}
