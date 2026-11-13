import { useCallback, useMemo, useRef, useState } from 'react'
import {
  PALETTE,
  blockToSource,
  compileBlocks,
  describeBlocks,
  makeBlock,
  type Block,
  type BlockPaletteItem,
} from '../lib/builder'

export interface NodeBuilderProps {
  blocks: Block[]
  onChange: (blocks: Block[]) => void
  onApply: (pattern: string) => void
  onClose: () => void
}

const GROUPS: Array<{ id: BlockPaletteItem['group']; label: string }> = [
  { id: 'atoms', label: 'Atoms' },
  { id: 'structure', label: 'Structure' },
  { id: 'repeat', label: 'Repeat' },
  { id: 'anchors', label: 'Anchors' },
]

/**
 * Drag-and-drop block builder.
 *
 * Palette items are HTML5-draggable and the canvas is a drop target; blocks can
 * also be appended by click (mobile/keyboard friendly) and reordered by dragging
 * within the track. The compiled pattern is live-previewed and can be pushed
 * straight into the editor.
 */
export function NodeBuilder({ blocks, onChange, onApply, onClose }: NodeBuilderProps) {
  const [dragging, setDragging] = useState<BlockPaletteItem | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragBlockId = useRef<string | null>(null)
  const compiled = useMemo(() => compileBlocks(blocks), [blocks])
  const descriptions = useMemo(() => describeBlocks(blocks), [blocks])

  const insert = useCallback(
    (item: BlockPaletteItem, index?: number) => {
      const block = makeBlock(item)
      const next = [...blocks]
      next.splice(index ?? next.length, 0, block)
      onChange(next)
    },
    [blocks, onChange],
  )

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return
      const next = [...blocks]
      const [item] = next.splice(from, 1)
      next.splice(to > from ? to - 1 : to, 0, item)
      onChange(next)
    },
    [blocks, onChange],
  )

  const update = useCallback(
    (id: string, patch: Partial<Block>) => {
      onChange(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)))
    },
    [blocks, onChange],
  )

  return (
    <div className="builder-overlay" role="dialog" aria-label="Visual node builder">
      <div className="builder">
        <header className="builder-head">
          <div>
            <h2>Node builder</h2>
            <p>Drag blocks into the track — they compile to a live regex.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close builder">
            ✕
          </button>
        </header>

        <div className="builder-body">
          <aside className="builder-palette">
            {GROUPS.map((group) => (
              <section key={group.id}>
                <h3>{group.label}</h3>
                <div className="palette-grid">
                  {PALETTE.filter((p) => p.group === group.id).map((item) => (
                    <button
                      key={item.kind}
                      type="button"
                      className="palette-item"
                      draggable
                      onDragStart={(e) => {
                        setDragging(item)
                        e.dataTransfer.effectAllowed = 'copy'
                        e.dataTransfer.setData('text/plain', item.kind)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropIndex(null)
                      }}
                      onClick={() => insert(item)}
                      title={`${item.label} — ${item.hint}`}
                    >
                      <span className="palette-icon">{item.icon}</span>
                      <span className="palette-label">{item.label}</span>
                      <code className="palette-hint">{item.hint}</code>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </aside>

          <section
            className={`builder-track${dragging ? ' is-dropping' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              if (dropIndex === null) setDropIndex(blocks.length)
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropIndex(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragging) insert(dragging, dropIndex ?? blocks.length)
              setDragging(null)
              setDropIndex(null)
            }}
          >
            {blocks.length === 0 && (
              <div className="builder-empty">
                <strong>Drop blocks here</strong>
                <span>or click a block in the palette to append it</span>
              </div>
            )}

            <div className="builder-blocks">
              {blocks.map((block, index) => (
                <div key={block.id} className="builder-slot">
                  {dropIndex === index && <div className="drop-marker" />}
                  <div
                    className="builder-block"
                    draggable
                    onDragStart={(e) => {
                      dragBlockId.current = block.id
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', block.id)
                    }}
                    onDragOver={(e) => {
                      if (dragBlockId.current) {
                        e.preventDefault()
                        setDropIndex(index)
                      }
                    }}
                    onDrop={(e) => {
                      if (dragBlockId.current) {
                        e.preventDefault()
                        const from = blocks.findIndex((b) => b.id === dragBlockId.current)
                        if (from >= 0) move(from, index)
                        dragBlockId.current = null
                        setDropIndex(null)
                      }
                    }}
                  >
                    <span className="block-order">{index + 1}</span>
                    <code className="block-src">{blockToSource(block) || '∅'}</code>

                    {['literal', 'class', 'negatedClass', 'alternation', 'capture'].includes(block.kind) && (
                      <input
                        className="block-input"
                        value={block.value}
                        onChange={(e) => update(block.id, { value: e.target.value })}
                        spellCheck={false}
                        aria-label={`value for block ${index + 1}`}
                      />
                    )}

                    {block.kind === 'quantifier' && (
                      <div className="block-segmented">
                        {['*', '+', '?'].map((q) => (
                          <button
                            key={q}
                            type="button"
                            className={block.value === q ? 'is-on' : ''}
                            onClick={() => update(block.id, { value: q })}
                          >
                            {q}
                          </button>
                        ))}
                        <label className="block-check">
                          <input
                            type="checkbox"
                            checked={!!block.lazy}
                            onChange={(e) => update(block.id, { lazy: e.target.checked })}
                          />
                          lazy
                        </label>
                      </div>
                    )}

                    {block.kind === 'setQuantifier' && (
                      <div className="block-range">
                        <input
                          type="number"
                          min={0}
                          max={999}
                          value={block.min ?? 0}
                          onChange={(e) => update(block.id, { min: Number(e.target.value) })}
                          aria-label="minimum repetitions"
                        />
                        <span>–</span>
                        <input
                          type="number"
                          min={0}
                          max={999}
                          value={block.max ?? ''}
                          placeholder="∞"
                          onChange={(e) =>
                            update(block.id, { max: e.target.value === '' ? undefined : Number(e.target.value) })
                          }
                          aria-label="maximum repetitions"
                        />
                      </div>
                    )}

                    <button
                      type="button"
                      className="block-remove"
                      onClick={() => onChange(blocks.filter((b) => b.id !== block.id))}
                      aria-label={`remove block ${index + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                  <span className="block-desc">{descriptions[index]}</span>
                </div>
              ))}
              {dropIndex !== null && dropIndex >= blocks.length && <div className="drop-marker" />}
            </div>
          </section>
        </div>

        <footer className="builder-foot">
          <div className="builder-preview">
            <span className="label">compiled regex</span>
            <code className="builder-pattern">{compiled.pattern || '(empty)'}</code>
            {compiled.pattern && (
              <div className="builder-code">
                <span className="label">as code</span>
                <code>{`new RegExp(${JSON.stringify(compiled.pattern)}, ${JSON.stringify('gm')})`}</code>
              </div>
            )}
            {compiled.warnings.length > 0 && (
              <ul className="builder-warnings">
                {compiled.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="builder-actions">
            <button type="button" className="ghost" onClick={() => onChange([])} disabled={blocks.length === 0}>
              Clear
            </button>
            <button
              type="button"
              className="primary"
              disabled={compiled.pattern.length === 0}
              onClick={() => onApply(compiled.pattern)}
            >
              Use this pattern →
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
