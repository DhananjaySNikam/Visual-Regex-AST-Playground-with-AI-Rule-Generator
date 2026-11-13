/**
 * Shared AST types for the Visual Regex & AST Playground.
 *
 * The AST is intentionally *lossless enough* to serialize back to source
 * (`srcStart`/`srcEnd` byte offsets into the original pattern) which powers the
 * bi-directional hover sync between the Monaco editor and the React Flow graph.
 */

export type NodeType =
  | 'alternation'
  | 'concat'
  | 'group'
  | 'char'
  | 'charClass'
  | 'dot'
  | 'shorthand'
  | 'quantifier'
  | 'anchor'
  | 'lookaround'
  | 'backref'

export type Flavor =
  | 'literal'
  | 'class'
  | 'group'
  | 'quantifier'
  | 'anchor'
  | 'wildcard'
  | 'alternation'
  | 'lookaround'
  | 'backref'
  | 'shorthand'

export interface CharRange {
  from: string
  to: string
}

export interface ClassItem {
  kind: 'range' | 'shorthand'
  /** Inclusive range for kind === 'range' */
  from: string
  to: string
  /** For shorthand: d D w W s S */
  shorthand?: string
}

export interface BaseNode {
  id: string
  type: NodeType
  flavor: Flavor
  /** Byte/char offsets into the source pattern (inclusive start, exclusive end). */
  srcStart: number
  srcEnd: number
  children: AstNode[]
  /** Short human label rendered inside the graph node. */
  label: string
  /** One-line explanation rendered in the inspector / tooltip. */
  explain: string
}

export interface AlternationNode extends BaseNode {
  type: 'alternation'
  children: AstNode[]
}

export interface ConcatNode extends BaseNode {
  type: 'concat'
  children: AstNode[]
}

export interface GroupNode extends BaseNode {
  type: 'group'
  groupKind: 'capture' | 'noncapture' | 'named'
  name?: string
  /** 1-based capture index (0 means non-capturing). */
  captureIndex: number
  children: [AstNode]
}

export interface CharNode extends BaseNode {
  type: 'char'
  value: string
}

export interface CharClassNode extends BaseNode {
  type: 'charClass'
  negated: boolean
  items: ClassItem[]
}

export interface DotNode extends BaseNode {
  type: 'dot'
}

export interface ShorthandNode extends BaseNode {
  type: 'shorthand'
  /** d D w W s S */
  shorthand: string
}

export interface QuantifierNode extends BaseNode {
  type: 'quantifier'
  min: number
  /** null means unbounded */
  max: number | null
  lazy: boolean
  children: [AstNode]
}

export interface AnchorNode extends BaseNode {
  type: 'anchor'
  kind: '^' | '$' | '\\b' | '\\B'
}

export interface LookaroundNode extends BaseNode {
  type: 'lookaround'
  kind: 'lookahead' | 'negLookahead' | 'lookbehind' | 'negLookbehind'
  children: [AstNode]
}

export interface BackrefNode extends BaseNode {
  type: 'backref'
  ref: string
}

export type AstNode =
  | AlternationNode
  | ConcatNode
  | GroupNode
  | CharNode
  | CharClassNode
  | DotNode
  | ShorthandNode
  | QuantifierNode
  | AnchorNode
  | LookaroundNode
  | BackrefNode

export interface ParseError {
  message: string
  index: number
}

export interface ParseResult {
  root: AstNode | null
  error: ParseError | null
  nodeCount: number
  maxDepth: number
}

export interface MatchSpan {
  start: number
  end: number
  text: string
  /** Capture group values, index 0 = whole match. */
  groups: (string | undefined)[]
  groupsNamed?: Record<string, string | undefined>
}

export type EngineMode = 'safe' | 'backtracking'

export interface MatchOptions {
  pattern: string
  input: string
  flags: string
  mode: EngineMode
  /** Hard step budget for the linear-time VM (protects against pathological input x pattern). */
  maxSteps?: number
}

export interface MatchStats {
  engine: EngineMode | 'fallback'
  steps: number
  elapsedMs: number
  /** Big-O characteristic of the executed engine. */
  complexity: string
  timedOut: boolean
  fallbackReason?: string
}

export interface MatchResult {
  matches: MatchSpan[]
  error: string | null
  stats: MatchStats
  parse: ParseResult
}

export interface AnalyzeReport {
  nodeCount: number
  maxDepth: number
  starHeight: number
  captureGroups: number
  distinctClasses: number
  /** true when the pattern contains constructs that require backtracking. */
  requiresBacktracking: boolean
  /** 0-100, higher = more dangerous. */
  riskScore: number
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  findings: Array<{
    id: string
    severity: 'info' | 'warn' | 'danger'
    title: string
    detail: string
    nodeIds: string[]
    suggestion?: string
  }>
  /** Big-O of the pattern under a Thompson NFA simulation. */
  automatonComplexity: string
}
