/**
 * Recursive-descent regex parser.
 *
 * Grammar (JavaScript-flavoured subset, extended with `(?<name>...)` and
 * lookarounds):
 *
 *   alternation := concat ('|' concat)*
 *   concat      := term*
 *   term        := atom quantifier?
 *   atom        := group | class | escape | char | dot | anchor
 *   quantifier  := ('*' | '+' | '?' | '{n,m}') '?'?
 *
 * Every produced node records its source span so the UI can map AST nodes back
 * to exact Monaco editor ranges.
 */
import type {
  AstNode,
  CharClassNode,
  ClassItem,
  ParseResult,
  QuantifierNode,
} from './types'

let idCounter = 0
const nextId = () => `n${(++idCounter).toString(36)}`

export function resetIds() {
  idCounter = 0
}

const CONTROL_NAMES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  f: '\f',
  v: '\v',
  '0': '\0',
}

const SHORTHAND_EXPLAIN: Record<string, string> = {
  d: 'any ASCII digit 0-9',
  D: 'any character that is not an ASCII digit',
  w: 'a word character (letter, digit or underscore)',
  W: 'a non-word character',
  s: 'whitespace (space, tab, newline…)',
  S: 'a non-whitespace character',
}

class Parser {
  pos = 0
  captureIndex = 0

  constructor(private src: string) {}

  parse(): ParseResult {
    try {
      if (this.src.length === 0) {
        return { root: null, error: null, nodeCount: 0, maxDepth: 0 }
      }
      const root = this.parseAlternation()
      if (this.pos < this.src.length) {
        throw new ParseFailure(`Unexpected "${this.src[this.pos]}"`, this.pos)
      }
      const { count, depth } = measure(root)
      return { root, error: null, nodeCount: count, maxDepth: depth }
    } catch (err) {
      const e = err as ParseFailure
      return {
        root: null,
        error: {
          message: e.message ?? 'Invalid regular expression',
          index: typeof e.index === 'number' ? e.index : this.pos,
        },
        nodeCount: 0,
        maxDepth: 0,
      }
    }
  }

  private parseAlternation(): AstNode {
    const start = this.pos
    const branches: AstNode[] = [this.parseConcat()]
    while (this.peek() === '|') {
      this.pos++
      branches.push(this.parseConcat())
    }
    if (branches.length === 1) return branches[0]
    return {
      id: nextId(),
      type: 'alternation',
      flavor: 'alternation',
      srcStart: start,
      srcEnd: this.pos,
      children: branches,
      label: 'either / or',
      explain: `Matches ${branches.length} alternative branches, tried left to right.`,
    }
  }

  private parseConcat(): AstNode {
    const start = this.pos
    const items: AstNode[] = []
    while (this.pos < this.src.length) {
      const ch = this.peek()
      if (ch === '|' || ch === ')') break
      items.push(this.parseTerm())
    }
    if (items.length === 1) return items[0]
    return {
      id: nextId(),
      type: 'concat',
      flavor: 'group',
      srcStart: start,
      srcEnd: this.pos,
      children: items,
      label: `sequence ×${items.length}`,
      explain: 'These elements must appear one after another, in this order.',
    }
  }

  private parseTerm(): AstNode {
    const atom = this.parseAtom()
    return this.parseQuantifier(atom)
  }

  private parseQuantifier(atom: AstNode): AstNode {
    const ch = this.peek()
    let min: number
    let max: number | null

    if (ch === '*') {
      this.pos++
      min = 0
      max = null
    } else if (ch === '+') {
      this.pos++
      min = 1
      max = null
    } else if (ch === '?') {
      this.pos++
      min = 0
      max = 1
    } else if (ch === '{') {
      const save = this.pos
      const brace = /^\{(\d+)(,(\d*)?)?\}/.exec(this.src.slice(this.pos))
      if (!brace) return atom
      this.pos += brace[0].length
      min = Number(brace[1])
      if (brace[0].includes(',')) {
        max = brace[3] === '' || brace[3] === undefined ? null : Number(brace[3])
      } else {
        max = min
      }
      if (max !== null && max < min) {
        throw new ParseFailure('Numbers out of order in {} quantifier', save)
      }
    } else {
      return atom
    }

    let lazy = false
    if (this.peek() === '?') {
      this.pos++
      lazy = true
    }

    const node: QuantifierNode = {
      id: nextId(),
      type: 'quantifier',
      flavor: 'quantifier',
      // The span covers the quantified element *and* its operator, so hovering
      // the node in the graph highlights `(ab|c)+`, not just the `+`.
      srcStart: atom.srcStart,
      srcEnd: this.pos,
      children: [atom],
      min,
      max,
      lazy,
      label: quantifierLabel(min, max, lazy),
      explain: quantifierExplain(min, max, lazy),
    }
    return node
  }

  private parseAtom(): AstNode {
    const start = this.pos
    const ch = this.src[this.pos]

    if (ch === undefined) throw new ParseFailure('Unexpected end of pattern', start)

    if (ch === '(') return this.parseGroup()
    if (ch === '[') return this.parseClass()
    if (ch === '.') {
      this.pos++
      return {
        id: nextId(),
        type: 'dot',
        flavor: 'wildcard',
        srcStart: start,
        srcEnd: this.pos,
        children: [],
        label: '.',
        explain: 'Matches any single character except a line terminator.',
      }
    }
    if (ch === '^' || ch === '$') {
      this.pos++
      return {
        id: nextId(),
        type: 'anchor',
        flavor: 'anchor',
        srcStart: start,
        srcEnd: this.pos,
        children: [],
        kind: ch,
        label: ch === '^' ? 'start' : 'end',
        explain: ch === '^' ? 'Asserts position at the start of the input (or line).' : 'Asserts position at the end of the input (or line).',
      }
    }
    if (ch === ')') throw new ParseFailure('Unmatched closing ")"', start)
    if (ch === '*' || ch === '+' || ch === '?') {
      throw new ParseFailure(`Nothing to repeat before "${ch}"`, start)
    }
    if (ch === '{') {
      // A brace that does not form a quantifier is a literal in JS.
      const brace = /^\{(\d+)(,(\d*)?)?\}/.exec(this.src.slice(this.pos))
      if (brace) throw new ParseFailure('Nothing to repeat before "{"', start)
    }
    if (ch === '\\') return this.parseEscape(false, start)

    this.pos++
    return {
      id: nextId(),
      type: 'char',
      flavor: 'literal',
      srcStart: start,
      srcEnd: this.pos,
      children: [],
      value: ch,
      label: ch === ' ' ? '␠' : ch,
      explain: `Matches the literal character "${ch}".`,
    }
  }

  private parseGroup(): AstNode {
    const start = this.pos
    this.pos++ // consume '('
    let groupKind: 'capture' | 'noncapture' | 'named' = 'capture'
    let name: string | undefined
    let lookKind: 'lookahead' | 'negLookahead' | 'lookbehind' | 'negLookbehind' | null = null

    if (this.peek() === '?') {
      this.pos++
      const marker = this.peek()
      if (marker === ':') {
        this.pos++
        groupKind = 'noncapture'
      } else if (marker === '=') {
        this.pos++
        lookKind = 'lookahead'
      } else if (marker === '!') {
        this.pos++
        lookKind = 'negLookahead'
      } else if (marker === '<') {
        const behind = this.src[this.pos + 1]
        if (behind === '=' || behind === '!') {
          this.pos += 2
          lookKind = behind === '=' ? 'lookbehind' : 'negLookbehind'
        } else {
          const m = /^<([A-Za-z_$][\w$]*)>/.exec(this.src.slice(this.pos))
          if (!m) throw new ParseFailure('Invalid capture group name', this.pos)
          this.pos += m[0].length
          groupKind = 'named'
          name = m[1]
        }
      } else {
        throw new ParseFailure('Unsupported group flag — only ?, ?:, ?=, ?!, ?<=, ?<! are supported', this.pos)
      }
    }

    const body = this.parseAlternation()
    if (this.peek() !== ')') throw new ParseFailure('Unterminated group — missing ")"', start)
    this.pos++

    if (lookKind) {
      const labels: Record<string, string> = {
        lookahead: 'lookahead ?=',
        negLookahead: 'neg. lookahead ?!',
        lookbehind: 'lookbehind ?<=',
        negLookbehind: 'neg. lookbehind ?<!',
      }
      const explains: Record<string, string> = {
        lookahead: 'Asserts that the following text matches, without consuming it.',
        negLookahead: 'Asserts that the following text does NOT match, without consuming it.',
        lookbehind: 'Asserts that the preceding text matches, without consuming it.',
        negLookbehind: 'Asserts that the preceding text does NOT match, without consuming it.',
      }
      return {
        id: nextId(),
        type: 'lookaround',
        flavor: 'lookaround',
        srcStart: start,
        srcEnd: this.pos,
        children: [body],
        kind: lookKind,
        label: labels[lookKind],
        explain: explains[lookKind],
      }
    }

    const captureIndex = groupKind === 'noncapture' ? 0 : ++this.captureIndex
    return {
      id: nextId(),
      type: 'group',
      flavor: 'group',
      srcStart: start,
      srcEnd: this.pos,
      children: [body],
      groupKind,
      name,
      captureIndex,
      label:
        groupKind === 'noncapture'
          ? 'group (?:)'
          : groupKind === 'named'
            ? `(?<${name}>)`
            : `capture #${captureIndex}`,
      explain:
        groupKind === 'noncapture'
          ? 'Groups elements for the quantifier / alternation without capturing.'
          : 'Groups elements and captures the matched text so it can be referenced or reported.',
    }
  }

  private parseClass(): AstNode {
    const start = this.pos
    this.pos++ // '['
    let negated = false
    if (this.peek() === '^') {
      negated = true
      this.pos++
    }
    const items: ClassItem[] = []
    let first = true
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch === ']' && !first) break
      first = false

      if (ch === '\\') {
        const esc = this.readEscape()
        if (esc.shorthand) {
          items.push({ kind: 'shorthand', shorthand: esc.shorthand, from: '', to: '' })
          continue
        }
        // escaped literal, may start a range
        const nextCh = this.src[this.pos]
        if (nextCh === '-' && this.src[this.pos + 1] !== ']' && this.pos + 1 < this.src.length) {
          this.pos++
          const hiEsc = this.peek() === '\\' ? this.readEscape().value : this.takeChar()
          items.push({ kind: 'range', from: esc.value, to: hiEsc })
          continue
        }
        items.push({ kind: 'range', from: esc.value, to: esc.value })
        continue
      }

      this.pos++
      const nextCh = this.src[this.pos]
      if (nextCh === '-' && this.src[this.pos + 1] !== ']' && this.pos + 1 < this.src.length) {
        this.pos++
        const hi = this.peek() === '\\' ? this.readEscape().value : this.takeChar()
        if (hi < ch) throw new ParseFailure('Range out of order in character class', start)
        items.push({ kind: 'range', from: ch, to: hi })
        continue
      }
      items.push({ kind: 'range', from: ch, to: ch })
    }
    if (this.peek() !== ']') throw new ParseFailure('Unterminated character class — missing "]"', start)
    this.pos++

    const node: CharClassNode = {
      id: nextId(),
      type: 'charClass',
      flavor: 'class',
      srcStart: start,
      srcEnd: this.pos,
      children: [],
      negated,
      items,
      label: classLabel(negated, items),
      explain: `Matches a single character ${negated ? 'NOT ' : ''}from ${items.length} alternative${items.length === 1 ? '' : 's'} in this set.`,
    }
    return node
  }

  private takeChar(): string {
    const ch = this.src[this.pos]
    if (ch === undefined) throw new ParseFailure('Unexpected end of character class', this.pos)
    this.pos++
    return ch
  }

  /** Reads an escape sequence starting at a backslash; advances pos past it. */
  private readEscape(): { shorthand?: string; value: string } {
    this.pos++ // backslash
    const ch = this.src[this.pos]
    if (ch === undefined) throw new ParseFailure('Pattern ends with a trailing backslash', this.pos)
    this.pos++
    if ('dDwWsS'.includes(ch)) return { shorthand: ch, value: '' }
    if (ch === 'b') return { shorthand: undefined, value: '\b' }
    if (ch in CONTROL_NAMES) return { value: CONTROL_NAMES[ch] }
    if (ch === 'x') {
      const hex = this.src.slice(this.pos, this.pos + 2)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ParseFailure('Invalid \\x escape', this.pos)
      this.pos += 2
      return { value: String.fromCharCode(parseInt(hex, 16)) }
    }
    if (ch === 'u') {
      if (this.src[this.pos] === '{') {
        const end = this.src.indexOf('}', this.pos)
        if (end === -1) throw new ParseFailure('Invalid \\u{...} escape', this.pos)
        const hex = this.src.slice(this.pos + 1, end)
        this.pos = end + 1
        return { value: String.fromCodePoint(parseInt(hex, 16)) }
      }
      const hex = this.src.slice(this.pos, this.pos + 4)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseFailure('Invalid \\u escape', this.pos)
      this.pos += 4
      return { value: String.fromCharCode(parseInt(hex, 16)) }
    }
    return { value: ch }
  }

  private parseEscape(inClass: boolean, start: number): AstNode {
    const esc = this.readEscape()
    if (esc.shorthand) {
      return {
        id: nextId(),
        type: 'shorthand',
        flavor: 'shorthand',
        srcStart: start,
        srcEnd: this.pos,
        children: [],
        shorthand: esc.shorthand,
        label: `\\${esc.shorthand}`,
        explain: `Matches ${SHORTHAND_EXPLAIN[esc.shorthand]}.`,
      }
    }
    if (this.src[start + 1] === 'b' || this.src[start + 1] === 'B') {
      const kind = ('\\' + this.src[start + 1]) as '\\b' | '\\B'
      return {
        id: nextId(),
        type: 'anchor',
        flavor: 'anchor',
        srcStart: start,
        srcEnd: this.pos,
        children: [],
        kind,
        label: kind === '\\b' ? 'word boundary' : 'non-boundary',
        explain:
          kind === '\\b'
            ? 'Asserts a boundary between a word character and a non-word character (zero-width).'
            : 'Asserts a position that is NOT a word boundary (zero-width).',
      }
    }
    if (!inClass && /[1-9]/.test(this.src[start + 1] ?? '')) {
      const m = /^\\(\d+)/.exec(this.src.slice(start))
      return {
        id: nextId(),
        type: 'backref',
        flavor: 'backref',
        srcStart: start,
        srcEnd: start + (m?.[0].length ?? 2),
        children: [],
        ref: m?.[1] ?? '',
        label: `backref \\${m?.[1]}`,
        explain: 'Re-matches the exact text captured by an earlier group. Requires a backtracking engine.',
      }
    }
    if (!inClass && this.src[start + 1] === 'k') {
      const m = /^\\k<([\w$]+)>/.exec(this.src.slice(start))
      if (m) {
        return {
          id: nextId(),
          type: 'backref',
          flavor: 'backref',
          srcStart: start,
          srcEnd: start + m[0].length,
          children: [],
          ref: m[1],
          label: `backref \\k<${m[1]}>`,
          explain: 'Re-matches text captured by the named group. Requires a backtracking engine.',
        }
      }
    }
    const printable = esc.value === '\n' ? '\\n' : esc.value === '\t' ? '\\t' : esc.value
    return {
      id: nextId(),
      type: 'char',
      flavor: 'literal',
      srcStart: start,
      srcEnd: this.pos,
      children: [],
      value: esc.value,
      label: `\\${this.src[start + 1]}`,
      explain: `Matches the literal character "${printable}".`,
    }
  }

  private peek(): string | undefined {
    return this.src[this.pos]
  }
}

class ParseFailure extends Error {
  constructor(
    message: string,
    public index: number,
  ) {
    super(message)
  }
}

function measure(node: AstNode): { count: number; depth: number } {
  let count = 1
  let depth = 1
  for (const child of node.children) {
    const m = measure(child)
    count += m.count
    depth = Math.max(depth, m.depth + 1)
  }
  return { count, depth }
}

function quantifierLabel(min: number, max: number | null, lazy: boolean) {
  const core =
    min === 0 && max === null
      ? 'zero or more'
      : min === 1 && max === null
        ? 'one or more'
        : min === 0 && max === 1
          ? 'optional'
          : max === min
            ? `exactly ${min}`
            : max === null
              ? `≥${min}`
              : `${min}–${max}`
  return `${core}${lazy ? ' (lazy)' : ''}`
}

function quantifierExplain(min: number, max: number | null, lazy: boolean) {
  const repetitions =
    max === null
      ? `at least ${min} time${min === 1 ? '' : 's'}`
      : min === max
        ? `exactly ${min} time${min === 1 ? '' : 's'}`
        : `between ${min} and ${max} times`
  return `Repeats the previous element ${repetitions}, ${lazy ? 'preferring as few as possible (lazy)' : 'preferring as many as possible (greedy)'}.`
}

function classLabel(negated: boolean, items: ClassItem[]) {
  const shown = items
    .slice(0, 4)
    .map((i) => (i.kind === 'shorthand' ? `\\${i.shorthand}` : i.from === i.to ? i.from : `${i.from}-${i.to}`))
    .join(' ')
  return `[${negated ? '^' : ''}${shown}${items.length > 4 ? '…' : ''}]`
}

export function parsePattern(pattern: string): ParseResult {
  resetIds()
  return new Parser(pattern).parse()
}

export function forEachNode(node: AstNode | null, fn: (n: AstNode) => void) {
  if (!node) return
  fn(node)
  for (const c of node.children) forEachNode(c, fn)
}

export function findNode(root: AstNode | null, id: string): AstNode | null {
  if (!root) return null
  if (root.id === id) return root
  for (const c of root.children) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

export function nodeAtOffset(root: AstNode | null, offset: number): AstNode | null {
  if (!root) return null
  if (offset < root.srcStart || offset >= root.srcEnd) return null
  for (const c of root.children) {
    const hit = nodeAtOffset(c, offset)
    if (hit) return hit
  }
  return root
}
