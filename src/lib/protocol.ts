import type { AnalyzeReport, MatchResult, ParseResult } from '../../shared/regex/types'

export type EngineMode = 'safe' | 'backtracking'

export type WorkerRequest =
  | { id: number; type: 'match'; pattern: string; input: string; flags: string; mode: EngineMode; maxSteps?: number }
  | { id: number; type: 'analyze'; pattern: string; flags: string }
  | { id: number; type: 'nodeMatches'; fragment: string; input: string; flags: string; maxSteps?: number }
  | { id: number; type: 'ping' }

export type WorkerResponse =
  | { id: number; type: 'match'; result: MatchResult }
  | { id: number; type: 'analyze'; result: { parse: ParseResult; report: AnalyzeReport; programUnsupported: string[] } }
  | { id: number; type: 'nodeMatches'; result: { spans: Array<[number, number]>; error: string | null } }
  | { id: number; type: 'pong' }
  | { id: number; type: 'error'; error: string }
