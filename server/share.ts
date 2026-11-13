/**
 * Share codec: O(1)-storage links.
 *
 * A playground state is serialized to compact JSON, compressed with Zstandard
 * and base64url-encoded straight into the URL hash (`#s=<payload>`). Nothing is
 * written to disk for a share, so storage cost is literally zero — the link
 * *is* the database. The same payload is what the `/api/share` endpoint can
 * optionally park in SQLite with a 24-hour TTL when a short code is preferred.
 */
import { zstdCompressSync, zstdDecompressSync, constants as zc } from 'node:zlib'
import { randomBytes, createHash } from 'node:crypto'

export interface SharePayload {
  v: 1
  /** pattern source */
  p: string
  /** flags */
  f: string
  /** corpus */
  t: string
  /** engine mode */
  m: 'safe' | 'backtracking'
  /** graph layout (node id -> position) */
  g?: Record<string, { x: number; y: number }>
  /** title */
  n?: string
  /** created at (ms) */
  c?: number
}

const MAX_INPUT = 64 * 1024

export function encodeShare(payload: SharePayload): { code: string; bytes: number; ratio: number } {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  if (json.length > 512 * 1024) throw new Error('Playground is too large to share (512 KiB limit)')
  const compressed = zstdCompressSync(json, {
    params: { [zc.ZSTD_c_compressionLevel as number]: 6 } as Record<number, number>,
  })
  const code = compressed.toString('base64url')
  return { code, bytes: compressed.length, ratio: json.length / Math.max(compressed.length, 1) }
}

export function decodeShare(code: string): SharePayload {
  if (code.length > 700_000) throw new Error('Share payload too large')
  const buf = Buffer.from(code, 'base64url')
  let json: Buffer
  try {
    json = zstdDecompressSync(buf)
  } catch {
    throw new Error('Malformed share payload (not a zstd frame)')
  }
  if (json.length > MAX_INPUT * 8) throw new Error('Share payload expands beyond the allowed size')
  const parsed = JSON.parse(json.toString('utf8')) as SharePayload
  if (parsed.v !== 1 || typeof parsed.p !== 'string') throw new Error('Unsupported share payload version')
  if (typeof parsed.t !== 'string' || parsed.t.length > MAX_INPUT) throw new Error('Corpus too large')
  return parsed
}

/** Deterministic short id derived from the payload — same state, same id. */
export function shareIdFor(code: string): string {
  return createHash('sha256').update(code).digest('base64url').slice(0, 12)
}

export function randomId(): string {
  return randomBytes(9).toString('base64url')
}
