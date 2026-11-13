import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { LayoutOverride } from '../lib/graph'

interface ShareDialogProps {
  payload: {
    p: string
    f: string
    t: string
    m: 'safe' | 'backtracking'
    g: LayoutOverride
  }
  onClose: () => void
}

/**
 * Share dialog.
 *
 * Default path is fully stateless: the playground is zstd-compressed into the
 * URL hash (`#s=…`) so there is nothing to store and the link never expires.
 * Opting in to a short code parks the same compressed blob in SQLite for 24h.
 */
export function ShareDialog({ payload, onClose }: ShareDialogProps) {
  const [code, setCode] = useState<string | null>(null)
  const [bytes, setBytes] = useState(0)
  const [ratio, setRatio] = useState(0)
  const [persisted, setPersisted] = useState<{ id: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const shareUrl = useMemo(() => {
    if (!code) return ''
    const base = `${window.location.origin}${window.location.pathname}`
    return `${base}#s=${code}`
  }, [code])

  const run = useCallback(
    async (persist: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const res = await api.share({ v: 1, ...payload }, persist)
        setCode(res.code)
        setBytes(res.bytes)
        setRatio(res.ratio)
        setPersisted(res.stored)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [payload],
  )

  useEffect(() => {
    void run(false)
  }, [run])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Clipboard blocked by the browser — select the URL and copy manually.')
    }
  }

  return (
    <div className="builder-overlay" role="dialog" aria-label="Share playground">
      <div className="share-dialog">
        <header className="builder-head">
          <div>
            <h2>Share this playground</h2>
            <p>Pattern, flags, corpus, engine mode and graph layout travel in the link.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="share-body">
          {loading && <p className="empty-note">Compressing with zstd…</p>}
          {error && <div className="error-box">{error}</div>}

          {code && (
            <>
              <label className="share-field">
                <span className="label">Stateless link (nothing stored, never expires)</span>
                <div className="share-url">
                  <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="primary" onClick={() => void copy()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </label>

              <ul className="share-stats">
                <li><span>payload</span><b>{bytes} B zstd</b></li>
                <li><span>compression</span><b>{ratio}×</b></li>
                <li><span>code length</span><b>{code.length} chars</b></li>
                <li><span>stored</span><b>{persisted ? '24h' : 'never'}</b></li>
              </ul>

              <div className="share-persist">
                <div>
                  <strong>Short code</strong>
                  <p>Park the same compressed blob in SQLite (WAL) with a 24-hour TTL.</p>
                </div>
                {persisted ? (
                  <code className="short-code">{persisted.id}</code>
                ) : (
                  <button type="button" className="ghost" onClick={() => void run(true)}>
                    Create 24h code
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
