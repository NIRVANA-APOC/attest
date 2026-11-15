// Typed decision protocol for the Jev decision model. A call carries one
// state and a small set of typed questions; answers are probabilities and
// named choices that the policy engine, never the model, turns into actions.
//
// State is untrusted data: instructions live only in a question, never in the
// state. A decision answer is a signal, never an authorization; the policy
// engine (`policy.ts`) and the deterministic pre-checks make the call.

export type JevQuestion =
  | { kind: 'noul'; question: string; instructions?: string }
  | { kind: 'choice'; question: string; options: string[]; instructions?: string }
  | { kind: 'score'; question: string; levels: number; criteria?: string[]; instructions?: string }

export type JevQuestions = Record<string, JevQuestion>

export type JevDecisionId =
  | 'plan.risk'
  | 'plan.clarity'
  | 'role.boundary'
  | 'result.fidelity'
  | 'drift.step'
  | 'merge.risk'
  | 'teardown.safety'
  | 'review.triage'

/** Every decision id, in the order the catalogue presents them. */
export const JEV_DECISION_IDS: JevDecisionId[] = [
  'plan.risk', 'plan.clarity', 'role.boundary', 'result.fidelity', 'drift.step', 'merge.risk', 'teardown.safety', 'review.triage',
]

export type JevBand = 'low' | 'medium' | 'high' | 'unknown'
export type JevAction = 'allow' | 'ask' | 'block' | 'shadow'
export type JevMode = 'shadow' | 'enforce'
export type JevProviderId = 'heuristic' | 'typesafe' | 'off'

/** Deterministic safety rules that can decide a question before a model is asked. */
export type JevPrecheckCode =
  | 'force-push'
  | 'destructive-command'
  | 'secret-path'
  | 'outside-touches'
  | 'hook-bypass'
  | 'unmerged-work'
  | 'dirty-work'

/** A deterministic pre-check's verdict; the only place a rule (not a model) decides. */
export type JevPrecheck = { code: JevPrecheckCode; detail: string; action: 'block' | 'ask' }

/** Stable reason codes, for the panel and for machine-readable reports. */
export type JevReasonCode =
  | 'policy.allow.low'
  | 'policy.ask.medium'
  | 'policy.block.high'
  | 'policy.shadow'
  | 'policy.fail-safe'
  | 'policy.missing-probability'
  | 'policy.no-question'
  | 'provider.disabled'
  | 'provider.error'
  | 'provider.fallback'
  | 'answer.malformed'
  | `precheck.${JevPrecheckCode}`

export type JevAnswer = {
  kind: 'noul' | 'choice' | 'score'
  /** Calibrated probability for noul and score answers, 0..1. */
  probability?: number
  /** Chosen option for a choice answer. */
  choice?: string
  confidence?: number
}

export type JevInput = {
  id: JevDecisionId
  /** Untrusted application state. Never carries instructions. */
  state: string | Record<string, unknown>
  questions: JevQuestions
  /** Stable digest of the state used for evidence and deduplication. */
  stateDigest?: string
}

export type JevOutcome = {
  id: JevDecisionId
  at: string
  provider: JevProviderId | string
  model?: string
  stateDigest: string
  answers: Record<string, JevAnswer>
  band: JevBand
  action: JevAction
  reason: string
  latencyMs: number
  /** Reported by a hosted provider, when it returns token usage. */
  usage?: { inputTokens?: number; outputTokens?: number }
  error?: string
  /** Stable reason code for the panel; `reason` stays the human sentence. */
  reasonCode?: JevReasonCode | string
  /** Present only when a deterministic rule decided instead of a model. */
  precheck?: JevPrecheck
}

export type JevProvider = {
  id: string
  decide(input: JevInput, limits?: { timeoutMs?: number }): Promise<Omit<JevOutcome, 'band' | 'action' | 'reason'>>
}

export type JevConfig = {
  mode: JevMode
  provider: JevProviderId
  questions?: JevDecisionId[]
}

/** A config as read from a plan's `audit:` block and the environment, plus what was wrong with it. */
export type LoadedJevConfig = JevConfig & { problems: string[] }

export type AuditChain = { ok: boolean; length: number; brokenAt?: number; incomplete?: boolean; reason?: string }

export type AuditRow = {
  seq: number
  id: string
  at: string
  band: string
  action: string
  probability?: number
  provider: string
  reason: string
  /** The outcome's state digest, for the panel's detail column. */
  stateDigest?: string
}

export type AuditView = {
  enabled: boolean
  mode: JevMode | 'off'
  provider: string
  chain: AuditChain
  counts: { allow: number; ask: number; block: number; shadow: number }
  risk: 'low' | 'medium' | 'high' | 'unknown'
  verdict: string
  lastAt?: string
  decisions: AuditRow[]
  calibration?: { n: number; brier: number; bins: { lo: number; hi: number; n: number; observed: number }[] }
}

/** A human or review verdict on a recorded decision, used to calibrate. */
export type AuditOutcomeVerdict = 'allow' | 'ask' | 'block' | 'defect' | 'pass'
export type AuditOutcomeSource = 'gate' | 'review' | 'human'

export type AuditOutcomeRecord = {
  /** The decision id this verdict judges. */
  id: JevDecisionId | string
  /** The ledger seq of the decision record; resolved from `id` when absent. */
  target?: number
  /** The action the policy took when the decision was made. */
  expected?: AuditOutcomeVerdict | string
  /** What a person or review actually found. */
  observed: AuditOutcomeVerdict
  source: AuditOutcomeSource
  note?: string
}

export type AuditVerifyPayload = { ok: boolean; length: number; brokenAt?: number; incomplete?: boolean; by?: string }

export type AuditRecordType = 'audit-decision' | 'audit-outcome' | 'audit-verify'

export type AuditRecord = {
  seq: number
  at: string
  type: AuditRecordType
  prev: string
  hash: string
  payload: unknown
}

/** One calibration observation: a decision's risk probability and what actually happened. */
export type JevSample = { id: string; at: string; p: number; observed: 0 | 1 }
