/**
 * Pike VM — a Thompson NFA simulation with capture support.
 *
 * Guarantees: the number of live threads is bounded by the program length, and
 * each input character advances every thread exactly once. Worst-case time is
 * therefore O(n · m) — no input can make this engine exponential. This is the
 * structural cure for ReDoS.
 *
 * Structure: `searchOnce` implements leftmost-first (Perl-style) priority for a
 * single match; `runPikeVm` repeats it after each match to enumerate all
 * non-overlapping matches, exactly like a global regex scan.
 *
 * `maxSteps` is a belt-and-braces budget so a huge input × huge pattern still
 * yields control quickly instead of spinning.
 */
import type { MatchSpan } from './types'
import type { Instr, Program } from './compile'
import { testCharSet } from './compile'

export interface RunResult {
  matches: MatchSpan[]
  steps: number
  timedOut: boolean
}

const MAX_MATCHES = 5000

interface Thread {
  pc: number
  caps: Int32Array
}

class ThreadList {
  threads: Thread[] = []
  private seen = new Set<number>()

  clear() {
    this.threads.length = 0
    this.seen.clear()
  }

  has(pc: number) {
    return this.seen.has(pc)
  }

  add(pc: number, caps: Int32Array) {
    this.seen.add(pc)
    this.threads.push({ pc, caps })
  }

  get size() {
    return this.threads.length
  }

  /** Keep the first `len` threads (drop lower-priority tails). */
  truncate(len: number) {
    while (this.threads.length > len) {
      const t = this.threads.pop()!
      this.seen.delete(t.pc)
    }
  }
}

export function runPikeVm(program: Program, input: string, flags: string, maxSteps = 4_000_000): RunResult {
  const { instrs } = program
  const slots = Math.max(2, (program.captureCount + 1) * 2)
  const multiline = flags.includes('m')
  const dotAll = flags.includes('s')
  const ignoreCase = flags.includes('i')
  const global = flags.includes('g')
  const sticky = flags.includes('y')

  const prog: Instr[] = instrs.map((ins) =>
    ins.op === 'char' && ins.set.isDot ? { ...ins, set: { ...ins.set, dotAll } } : ins,
  )

  let clist = new ThreadList()
  let nlist = new ThreadList()
  const matches: MatchSpan[] = []
  let steps = 0
  let timedOut = false
  let budget = maxSteps

  const addThread = (list: ThreadList, pc0: number, caps0: Int32Array, pos: number) => {
    const stack: Array<{ pc: number; caps: Int32Array }> = [{ pc: pc0, caps: caps0 }]
    while (stack.length) {
      const { pc, caps } = stack.pop()!
      if (list.has(pc)) continue
      const ins = prog[pc]
      switch (ins.op) {
        case 'jmp':
          stack.push({ pc: ins.x, caps })
          break
        case 'split':
          stack.push({ pc: ins.y, caps })
          stack.push({ pc: ins.x, caps })
          break
        case 'save': {
          const next = caps.slice()
          next[ins.slot] = pos
          list.add(pc, next)
          stack.push({ pc: ins.next !== undefined && ins.next >= 0 ? ins.next : pc + 1, caps: next })
          break
        }
        case 'assert':
          if (assertHolds(ins.kind, input, pos, multiline)) stack.push({ pc: pc + 1, caps })
          break
        case 'unsupported':
          break
        case 'match':
        case 'char':
          list.add(pc, caps)
          break
      }
    }
  }

  /** Returns caps for the leftmost-first match starting at or after `from`. */
  const searchOnce = (from: number): Int32Array | null => {
    clist.clear()
    addThread(clist, 0, new Int32Array(slots).fill(-1), from)
    let matched: Int32Array | null = null
    let pos = from
    const n = input.length

    while (pos <= n) {
      if (steps > budget) {
        timedOut = true
        return matched
      }

      // Highest-priority match thread wins; drop the lower-priority tail.
      let matchIdx = -1
      for (let i = 0; i < clist.size; i++) {
        if (prog[clist.threads[i].pc].op === 'match') {
          matchIdx = i
          break
        }
      }
      if (matchIdx !== -1) {
        // Leftmost-first: the first match thread we reach is the best one so
        // far. Higher-priority threads (earlier in the list) may still improve
        // it (longer / preferred alternative), everything at or below is dead.
        // Every further match we reach comes from a higher-priority thread, so
        // it is at least as good: greedy quantifiers keep extending the span
        // until no thread can consume more.
        matched = clist.threads[matchIdx].caps
        clist.truncate(matchIdx)
        if (sticky) break
      }

      if (pos === n) break

      const code = input.codePointAt(pos) ?? -1
      const width = code > 0xffff ? 2 : 1
      nlist.clear()

      for (let i = 0; i < clist.size; i++) {
        const t = clist.threads[i]
        const ins = prog[t.pc]
        if (ins.op !== 'char') continue
        steps++
        let ok = testCharSet(ins.set, code)
        if (!ok && ignoreCase && code > 0) {
          const ch = String.fromCodePoint(code)
          ok =
            testCharSet(ins.set, ch.toLowerCase().codePointAt(0) ?? -1) ||
            testCharSet(ins.set, ch.toUpperCase().codePointAt(0) ?? -1)
        }
        if (ok) addThread(nlist, t.pc + 1, t.caps, pos + width)
      }

      // Unanchored search: a fresh thread starts at every position. Once a
      // match is locked in, later start positions are strictly worse, so we
      // stop seeding.
      if (!sticky && !matched) addThread(nlist, 0, new Int32Array(slots).fill(-1), pos + width)

      const tmp = clist
      clist = nlist
      nlist = tmp
      pos += width

      if (clist.size === 0) break
      // An anchored pattern that can never start later will die here naturally.
    }

    return matched
  }

  const toSpan = (caps: Int32Array): MatchSpan => {
    const start = caps[0]
    const end = caps[1]
    const groups: (string | undefined)[] = []
    for (let g = 0; g <= program.captureCount; g++) {
      const gs = caps[g * 2]
      const ge = caps[g * 2 + 1]
      groups[g] = gs >= 0 && ge >= 0 && ge >= gs ? input.slice(gs, ge) : undefined
    }
    const named: Record<string, string | undefined> = {}
    program.groupNames.forEach((name, g) => {
      if (name) named[name] = groups[g]
    })
    return { start, end, text: input.slice(start, end), groups, groupsNamed: named }
  }

  let cursor = 0
  while (cursor <= input.length && !timedOut && matches.length < MAX_MATCHES) {
    budget = maxSteps - steps
    if (budget <= 0) {
      timedOut = true
      break
    }
    const caps = searchOnce(cursor)
    if (!caps || caps[0] < 0 || caps[1] < 0) break
    const span = toSpan(caps)
    matches.push(span)
    if (!global && !sticky) break
    cursor = span.end > span.start ? span.end : span.end + 1
  }

  return { matches, steps, timedOut }
}

function assertHolds(kind: '^' | '$' | '\\b' | '\\B', input: string, pos: number, multiline: boolean): boolean {
  switch (kind) {
    case '^':
      return pos === 0 || (multiline && input[pos - 1] === '\n')
    case '$':
      return pos === input.length || (multiline && input[pos] === '\n')
    case '\\b':
    case '\\B': {
      const before = pos > 0 ? isWordChar(input[pos - 1]) : false
      const after = pos < input.length ? isWordChar(input[pos]) : false
      const boundary = before !== after
      return kind === '\\b' ? boundary : !boundary
    }
  }
}

function isWordChar(ch: string) {
  return /[A-Za-z0-9_]/.test(ch)
}
