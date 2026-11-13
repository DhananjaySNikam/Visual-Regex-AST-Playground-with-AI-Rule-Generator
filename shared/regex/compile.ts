/**
 * Character-set algebra + AST → Thompson NFA compilation.
 *
 * The NFA is the reason matching is linear-time: there is no way to "jump back"
 * into the pattern, so the number of active states can never exceed the program
 * length. That is what makes ReDoS impossible here.
 */
import type { AstNode, CharClassNode, ClassItem } from './types'
import { forEachNode } from './parser'

export interface CharSet {
  ranges: Array<[number, number]>
  negated: boolean
  /** dot: excludes line terminators unless dotAll */
  isDot?: boolean
  dotAll?: boolean
}

export const D_RANGES: Array<[number, number]> = [[48, 57]]
export const W_RANGES: Array<[number, number]> = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
]
export const S_RANGES: Array<[number, number]> = [
  [9, 13],
  [32, 32],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]

export function shorthandRanges(s: string): Array<[number, number]> {
  const base = s === 'd' || s === 'D' ? D_RANGES : s === 'w' || s === 'W' ? W_RANGES : S_RANGES
  return base
}

export function invert(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  let cursor = 0
  for (const [lo, hi] of sorted) {
    if (lo > cursor) out.push([cursor, lo - 1])
    cursor = Math.max(cursor, hi + 1)
  }
  if (cursor <= 0x10ffff) out.push([cursor, 0x10ffff])
  return out
}

export function testCharSet(set: CharSet, code: number): boolean {
  if (set.isDot) {
    const excluded = set.dotAll ? false : code === 10 || code === 13 || code === 0x2028 || code === 0x2029
    return !excluded
  }
  let hit = false
  for (const [lo, hi] of set.ranges) {
    if (code >= lo && code <= hi) {
      hit = true
      break
    }
  }
  return set.negated ? !hit : hit
}

export function itemToRanges(items: ClassItem[]): { ranges: Array<[number, number]>; negated: boolean } {
  const ranges: Array<[number, number]> = []
  let negated = false
  for (const item of items) {
    if (item.kind === 'shorthand') {
      const s = item.shorthand!
      const base = shorthandRanges(s)
      if (s === s.toUpperCase()) {
        // \D \W \S inside a class: union with the complement
        ranges.push(...invert(base))
      } else {
        ranges.push(...base)
      }
    } else {
      ranges.push([item.from.codePointAt(0) ?? 0, item.to.codePointAt(0) ?? 0])
    }
  }
  return { ranges, negated }
}

// ---------------------------------------------------------------------------
// NFA program
// ---------------------------------------------------------------------------

export type Instr =
  | { op: 'char'; set: CharSet; nodeId: string }
  | { op: 'split'; x: number; y: number; nodeId: string }
  | { op: 'jmp'; x: number; nodeId: string }
  | { op: 'save'; slot: number; nodeId: string; next?: number }
  | { op: 'assert'; kind: '^' | '$' | '\\b' | '\\B'; nodeId: string }
  | { op: 'match'; nodeId: string }
  /** Backreferences and lookarounds are compiled as opaque markers so the
   *  analyzer can flag them; the Pike VM never executes them. */
  | { op: 'unsupported'; reason: string; nodeId: string }

export interface Program {
  instrs: Instr[]
  captureCount: number
  groupNames: string[]
  unsupported: string[]
}

interface Frag {
  start: number
  outs: Array<{ at: number; field: 'x' | 'y' }>
}

class Builder {
  instrs: Instr[] = []
  captureCount = 0
  groupNames: string[] = []
  unsupported: string[] = []

  emit(instr: Instr): number {
    this.instrs.push(instr)
    return this.instrs.length - 1
  }

  /**
   * A single-step instruction (char / assert) followed by an explicit jmp.
   * The jmp is the fragment's patchable exit, which keeps fragment building
   * uniform: every fragment ends in a jump-or-split we can rewrite.
   */
  emitStep(instr: Instr): Frag {
    const pc = this.emit(instr)
    const out = this.emit({ op: 'jmp', x: 0, nodeId: instr.nodeId })
    return { start: pc, outs: [{ at: out, field: 'x' }] }
  }

  build(node: AstNode): Frag {
    switch (node.type) {
      case 'char': {
        const code = node.value.codePointAt(0) ?? 0
        return this.emitStep({ op: 'char', set: { ranges: [[code, code]], negated: false }, nodeId: node.id })
      }
      case 'dot':
        return this.emitStep({ op: 'char', set: { ranges: [], negated: false, isDot: true }, nodeId: node.id })
      case 'shorthand':
        return this.emitStep({ op: 'char', set: shorthandSet(node.shorthand), nodeId: node.id })
      case 'charClass':
        return this.emitStep({ op: 'char', set: classSet(node), nodeId: node.id })
      case 'anchor':
        return this.emitStep({ op: 'assert', kind: node.kind, nodeId: node.id })
      case 'concat': {
        if (node.children.length === 0) return this.epsilon(node.id)
        let frag = this.build(node.children[0])
        for (let i = 1; i < node.children.length; i++) {
          const next = this.build(node.children[i])
          frag = this.concat(frag, next)
        }
        return frag
      }
      case 'alternation': {
        let frag = this.build(node.children[0])
        for (let i = 1; i < node.children.length; i++) {
          const right = this.build(node.children[i])
          const split = this.emit({ op: 'split', x: frag.start, y: right.start, nodeId: node.id })
          frag = { start: split, outs: [...frag.outs, ...right.outs] }
        }
        return frag
      }
      case 'group': {
        if (node.groupKind === 'noncapture') return this.build(node.children[0])
        const idx = node.captureIndex
        this.captureCount = Math.max(this.captureCount, idx)
        if (node.name) this.groupNames[idx] = node.name
        const open = this.emit({ op: 'save', slot: idx * 2, nodeId: node.id, next: -1 })
        const body = this.build(node.children[0])
        this.instrs[open] = { ...(this.instrs[open] as Extract<Instr, { op: 'save' }>), next: body.start }
        const close = this.emit({ op: 'save', slot: idx * 2 + 1, nodeId: node.id })
        this.patch(body, close)
        // close falls through to whatever follows
        return { start: open, outs: [{ at: close, field: 'y' }] }
      }
      case 'quantifier': {
        return this.buildQuantifier(node)
      }
      case 'lookaround': {
        this.unsupported.push(`lookaround (${node.kind}) requires a backtracking engine`)
        const pc = this.emit({ op: 'unsupported', reason: `lookaround ${node.kind}`, nodeId: node.id })
        return { start: pc, outs: [{ at: pc, field: 'y' }] }
      }
      case 'backref': {
        this.unsupported.push('backreference requires a backtracking engine')
        const pc = this.emit({ op: 'unsupported', reason: `backreference \\${node.ref}`, nodeId: node.id })
        return { start: pc, outs: [{ at: pc, field: 'y' }] }
      }
    }
  }

  private buildQuantifier(node: Extract<AstNode, { type: 'quantifier' }>): Frag {
    const body = node.children[0]
    const { min, max, lazy } = node

    if (min === 0 && max === null) return this.star(body, lazy, node.id)
    if (min === 1 && max === null) return this.plus(body, lazy, node.id)
    if (min === 0 && max === 1) return this.optional(body, lazy, node.id)

    // Generalised {n,m}: expand by cloning (bounded expansion keeps the NFA small
    // because m is capped by the parser).
    const clone = (n: AstNode): Frag => this.build(n)
    let frag: Frag | null = null
    for (let i = 0; i < min; i++) {
      const piece = clone(body)
      frag = frag ? this.concat(frag, piece) : piece
    }
    if (max === null) {
      const tail = this.star(body, lazy, node.id)
      frag = frag ? this.concat(frag, tail) : tail
    } else {
      for (let i = min; i < max; i++) {
        const piece = this.optional(body, lazy, node.id)
        frag = frag ? this.concat(frag, piece) : piece
      }
    }
    return frag ?? this.epsilon(node.id)
  }

  private epsilon(nodeId: string): Frag {
    const pc = this.emit({ op: 'jmp', x: 0, nodeId })
    return { start: pc, outs: [{ at: pc, field: 'x' }] }
  }

  private star(body: AstNode, lazy: boolean, nodeId: string): Frag {
    const piece = this.build(body)
    const split = this.emit({ op: 'split', x: piece.start, y: 0, nodeId })
    this.patch(piece, split)
    // greedy: x = body, y = exit; lazy: swap
    this.instrs[split] =
      lazy
        ? { op: 'split', x: 0, y: piece.start, nodeId }
        : { op: 'split', x: piece.start, y: 0, nodeId }
    return { start: split, outs: [{ at: split, field: lazy ? 'x' : 'y' }] }
  }

  private plus(body: AstNode, lazy: boolean, nodeId: string): Frag {
    const piece = this.build(body)
    const split = this.emit({ op: 'split', x: piece.start, y: 0, nodeId })
    this.patch(piece, split)
    this.instrs[split] =
      lazy
        ? { op: 'split', x: 0, y: piece.start, nodeId }
        : { op: 'split', x: piece.start, y: 0, nodeId }
    return { start: piece.start, outs: [{ at: split, field: lazy ? 'x' : 'y' }] }
  }

  private optional(body: AstNode, lazy: boolean, nodeId: string): Frag {
    const piece = this.build(body)
    const split = this.emit({
      op: 'split',
      x: lazy ? 0 : piece.start,
      y: lazy ? piece.start : 0,
      nodeId,
    })
    return {
      start: split,
      // The exit hole is `x` for a lazy split (body is on y) and `y` otherwise.
      outs: [{ at: split, field: lazy ? 'x' : 'y' } as { at: number; field: 'x' | 'y' }, ...piece.outs],
    }
  }

  private concat(a: Frag, b: Frag): Frag {
    this.patch(a, b.start)
    return { start: a.start, outs: b.outs }
  }

  patchOuts(frag: Frag, target: number) {
    this.patch(frag, target)
  }

  private patch(frag: Frag, target: number) {
    for (const out of frag.outs) {
      const instr = this.instrs[out.at]
      if (instr.op === 'split') {
        this.instrs[out.at] = { ...instr, [out.field]: target }
      } else if (instr.op === 'jmp') {
        this.instrs[out.at] = { ...instr, x: target }
      } else if (instr.op === 'char') {
        // char instructions fall through; nothing to patch
      } else if (instr.op === 'save' || instr.op === 'assert' || instr.op === 'unsupported') {
        // fall through
      }
    }
  }
}

export function shorthandSet(s: string): CharSet {
  const base = shorthandRanges(s.toLowerCase())
  const negated = s === s.toUpperCase()
  return { ranges: base, negated }
}

export function classSet(node: CharClassNode): CharSet {
  const { ranges, negated } = itemToRanges(node.items)
  return { ranges, negated: negated !== node.negated ? true : false }
}

export function compile(root: AstNode, flags: string): Program {
  const b = new Builder()
  const frag = b.build(root)
  const bodyLen = b.instrs.length
  // Layout: [save0][jmp body] ...body... [save1][match]
  // Patch outs to the *unshifted* end slot; shiftInstr adds the 2-instruction
  // entry prologue offset afterwards.
  b.patchOuts(frag, bodyLen)
  const shifted = b.instrs.map(shiftInstr(2))
  const instrs: Instr[] = [
    { op: 'save', slot: 0, nodeId: 'start' },
    { op: 'jmp', x: frag.start + 2, nodeId: 'entry' },
    ...shifted,
    { op: 'save', slot: 1, nodeId: 'end' },
    { op: 'match', nodeId: 'match' },
  ]
  void flags
  return {
    instrs,
    captureCount: b.captureCount,
    groupNames: b.groupNames,
    unsupported: b.unsupported,
  }
}

function shiftInstr(offset: number) {
  return (instr: Instr): Instr => {
    switch (instr.op) {
      case 'split':
        return { ...instr, x: instr.x + offset, y: instr.y + offset }
      case 'jmp':
        return { ...instr, x: instr.x + offset }
      case 'save':
        return instr.next !== undefined && instr.next >= 0 ? { ...instr, next: instr.next + offset } : instr
      default:
        return instr
    }
  }
}

/** Collects every AST node id that participates in a character-consuming path. */
export function collectNodeIds(root: AstNode): string[] {
  const ids: string[] = []
  forEachNode(root, (n) => ids.push(n.id))
  return ids
}
