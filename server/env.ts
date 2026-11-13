/**
 * Minimal .env loader (no dependency).
 *
 * `node --env-file` refuses to start when the file is missing, which is a bad
 * developer experience for a repo whose .env is optional. This loader is
 * silent when there is nothing to load and never overwrites real env vars.
 */
import fs from 'node:fs'
import path from 'node:path'

export function loadEnv(file = '.env') {
  const full = path.resolve(process.cwd(), file)
  if (!fs.existsSync(full)) return
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}
