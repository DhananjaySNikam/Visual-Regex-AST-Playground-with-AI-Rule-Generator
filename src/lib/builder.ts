/**
 * Visual block builder model.
 *
 * The builder is a flat, ordered list of blocks that compiles to regex source.
 * It is deliberately a *sequence* model (like scratch blocks) rather than a full
 * syntax tree: every block knows how to render itself and what it contributes,
 * so the mapping back to valid regex is total and predictable.
 */

export type BlockKind =
  | 'literal'
  | 'digits'
  | 'word'
  | 'space'
  | 'any'
  | 'class'
  | 'negatedClass'
  | 'alternation'
  | 'groupStart'
  | 'groupEnd'
  | 'anchorStart'
  | 'anchorEnd'
  | 'wordBoundary'
  | 'quantifier'
  | 'setQuantifier'
  | 'optional'
  | 'capture'

export interface Block {
  id: string
  kind: BlockKind
  /** User-editable payload: literal text, class contents, alternatives, n/m. */
  value: string
  min?: number
  max?: number
  lazy?: boolean
}

export interface BlockPaletteItem {
  kind: BlockKind
  label: string
  hint: string
  icon: string
  group: 'atoms' | 'structure' | 'repeat' | 'anchors'
  default: Partial<Block>
}

export const PALETTE: BlockPaletteItem[] = [
  { kind: 'literal', label: 'Literal', hint: 'Exact text', icon: 'Aa', group: 'atoms', default: { value: 'abc' } },
  { kind: 'digits', label: 'Digits', hint: '\\d', icon: '0-9', group: 'atoms', default: { value: '' } },
  { kind: 'word', label: 'Word char', hint: '\\w', icon: '\\w', group: 'atoms', default: { value: '' } },
  { kind: 'space', label: 'Whitespace', hint: '\\s', icon: '␠', group: 'atoms', default: { value: '' } },
  { kind: 'any', label: 'Any char', hint: '.', icon: '·', group: 'atoms', default: { value: '' } },
  { kind: 'class', label: 'Char class', hint: '[ … ]', icon: '[a-z]', group: 'atoms', default: { value: 'a-z' } },
  { kind: 'negatedClass', label: 'Not in class', hint: '[^ … ]', icon: '[^]', group: 'atoms', default: { value: '\\s' } },
  { kind: 'alternation', label: 'Either / or', hint: 'a|b', icon: 'a|b', group: 'structure', default: { value: 'cat|dog' } },
  { kind: 'capture', label: 'Capture', hint: '( … )', icon: '( )', group: 'structure', default: { value: '(\\w+)' } },
  { kind: 'quantifier', label: 'Repeat', hint: '* + ? {n,m}', icon: '*', group: 'repeat', default: { value: '*', min: 0 } },
  { kind: 'setQuantifier', label: 'Repeat n–m', hint: '{n,m}', icon: '{n,m}', group: 'repeat', default: { min: 2, max: 4 } },
  { kind: 'anchorStart', label: 'Start of line', hint: '^', icon: '^', group: 'anchors', default: { value: '' } },
  { kind: 'anchorEnd', label: 'End of line', hint: '$', icon: '$', group: 'anchors', default: { value: '' } },
  { kind: 'wordBoundary', label: 'Word boundary', hint: '\\b', icon: '\\b', group: 'anchors', default: { value: '' } },
]

let seq = 0
export function blockId() {
  return `b${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function makeBlock(item: BlockPaletteItem): Block {
  return {
    id: blockId(),
    kind: item.kind,
    value: item.default.value ?? '',
    min: item.default.min,
    max: item.default.max,
    lazy: false,
  }
}

const SHORTHANDS: Partial<Record<BlockKind, string>> = {
  digits: '\\d',
  word: '\\w',
  space: '\\s',
  any: '.',
}

function escapeLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function blockToSource(block: Block): string {
  switch (block.kind) {
    case 'literal':
      return escapeLiteral(block.value)
    case 'digits':
    case 'word':
    case 'space':
    case 'any':
      return SHORTHANDS[block.kind] ?? ''
    case 'class':
      return `[${block.value}]`
    case 'negatedClass':
      return `[^${block.value}]`
    case 'alternation':
      return `(?:${block.value})`
    case 'capture':
      return block.value.startsWith('(') ? block.value : `(${block.value})`
    case 'groupStart':
      return '('
    case 'groupEnd':
      return ')'
    case 'anchorStart':
      return '^'
    case 'anchorEnd':
      return '$'
    case 'wordBoundary':
      return '\\b'
    case 'quantifier': {
      const base = quantifierToken(block)
      return base + (block.lazy ? '?' : '')
    }
    case 'setQuantifier': {
      const min = block.min ?? 0
      const max = block.max
      const body = max === undefined || max === min ? `{${min}}` : `{${min},${max}}`
      return body + (block.lazy ? '?' : '')
    }
    default:
      return ''
  }
}

function quantifierToken(block: Block) {
  switch (block.value) {
    case '+':
      return '+'
    case '?':
      return '?'
    case '*':
      return '*'
    default:
      return '*'
  }
}

export interface CompileResult {
  pattern: string
  warnings: string[]
  /** Which blocks may legally take a quantifier (used for UI affordance). */
  quantifiableIds: Set<string>
}

export function compileBlocks(blocks: Block[]): CompileResult {
  const warnings: string[] = []
  let depth = 0
  const parts: string[] = []
  const quantifiableIds = new Set<string>()
  let previousWasTerm = false

  for (const block of blocks) {
    const isQuantifier = block.kind === 'quantifier' || block.kind === 'setQuantifier'
    if (isQuantifier) {
      if (!previousWasTerm) {
        warnings.push(`A repeat block needs something to repeat (block ${parts.length + 1}).`)
        continue
      }
      parts.push(blockToSource(block))
      previousWasTerm = false
      continue
    }

    if (block.kind === 'groupStart') depth++
    if (block.kind === 'groupEnd') {
      depth--
      if (depth < 0) {
        warnings.push('A closing group has no matching opening group.')
        depth = 0
        continue
      }
      parts.push(')')
      previousWasTerm = true
      continue
    }

    if (previousWasTerm) quantifiableIds.add(parts.length.toString())
    parts.push(blockToSource(block))
    previousWasTerm = block.kind !== 'anchorStart' && block.kind !== 'anchorEnd' && block.kind !== 'wordBoundary'
    void isQuantifier
  }

  if (depth > 0) warnings.push(`${depth} group(s) were never closed.`)
  return { pattern: parts.join(''), warnings, quantifiableIds }
}

/** Pretty-prints a compiled builder sequence for the "what will this match" hint. */
export function describeBlocks(blocks: Block[]): string[] {
  return blocks.map((b) => {
    switch (b.kind) {
      case 'literal':
        return `the text "${b.value}"`
      case 'digits':
        return 'a digit'
      case 'word':
        return 'a word character'
      case 'space':
        return 'whitespace'
      case 'any':
        return 'any character'
      case 'class':
        return `one of [${b.value}]`
      case 'negatedClass':
        return `one character not in [${b.value}]`
      case 'alternation':
        return `one of (${b.value})`
      case 'capture':
        return `a captured group ${b.value}`
      case 'groupStart':
        return 'start of a group'
      case 'groupEnd':
        return 'end of a group'
      case 'anchorStart':
        return 'start of the line'
      case 'anchorEnd':
        return 'end of the line'
      case 'wordBoundary':
        return 'a word boundary'
      case 'quantifier':
        return `repeated ${b.value === '*' ? 'zero or more times' : b.value === '+' ? 'one or more times' : 'optionally'}`
      case 'setQuantifier':
        return b.max === undefined ? `repeated ${b.min} times` : `repeated ${b.min}–${b.max} times`
      default:
        return ''
    }
  })
}
