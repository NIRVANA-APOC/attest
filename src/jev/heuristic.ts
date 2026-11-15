// The deterministic, offline provider. It is a heuristic, not the real
// TypeSafe model, and says so everywhere (`provider: 'heuristic'`, bounded
// confidence). It reads documented features of the *state* — destructive
// commands, paths, touches coverage, done-when evidence, diff size, reviews,
// ambiguity markers — combines them with the transparent weighting table
// below, and only applies a recalibration map that the ledger's own outcomes
// validated on a holdout split (`calibration.ts`).
//
// State is untrusted data: this module scans it, never follows it.
import { calibrateProbability, fitCalibration } from './calibration.ts'
import type { CalibrationFit } from './calibration.ts'
import { digestOf } from './ledger.ts'
import type { JevAnswer, JevDecisionId, JevInput, JevPrecheckCode, JevProvider, JevQuestions, JevSample } from './types.ts'

export const HEURISTIC_ID = 'heuristic'
/** The version stamped on heuristic outcomes; bump when the weights change. */
export const HEURISTIC_MODEL = 'heuristic-v1'

export type JevFeatureName =
  | 'hazard'
  | 'secretPath'
  | 'outsideTouches'
  | 'touchesUncovered'
  | 'doneWhenGap'
  | 'evidenceGap'
  | 'diffSize'
  | 'reviewGap'
  | 'ambiguity'
  | 'scope'
  | 'statusRisk'
  | 'drift'
  | 'dirty'

export type JevFeatures = Record<JevFeatureName, number>
export type JevFeatureKnown = Record<JevFeatureName, boolean>

export type Featured = {
  /** Normalised 0..1 feature values; unknown features are 0. */
  features: JevFeatures
  known: JevFeatureKnown
  /** No structural signal at all: the provider answers 0.5 and the policy asks. */
  sparse: boolean
  /** Deterministic safety codes found in the state (pre-check input). */
  hazards: JevPrecheckCode[]
}

const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(one => (typeof one === 'string' ? [one] : []))
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(one => one !== '')

  return []
}
const has = (raw: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key)

/** Paths are compared as repo-relative strings; a touch covers itself, its directory and simple `*` globs. */
export const coversPath = (touch: string, path: string): boolean => {
  const cleanPath = (value: string) => value.trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '')
  const declared = cleanPath(touch)
  const changed = cleanPath(path)
  if (declared === '') return false
  if (declared.includes('*')) {
    const pattern = new RegExp(`^${declared.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

    return pattern.test(changed)
  }

  return changed === declared || changed.startsWith(`${declared}/`)
}

const TEXT_KEYS = ['text', 'plan', 'goal', 'step', 'summary', 'result', 'body', 'brief', 'why', 'note', 'notes']

/** Keys that carry structural signal; a state with none of them and no lexical evidence is unscoreable. */
const INFORMATIVE_KEYS = ['touches', 'changed', 'outside', 'doneWhen', 'doneWhenMet', 'status', 'diff', 'diffLines', 'files', 'commits', 'checks', 'reviews', 'roles', 'roleCount', 'results', 'overlap', 'dirty', 'untracked', 'unmerged', 'unpushed']

const rawOf = (state: string | Record<string, unknown>): Record<string, unknown> => (typeof state === 'string' ? { text: state } : recordOf(state))

/** Untrusted free text, bounded; paths are scanned separately but through the same patterns. */
const textOf = (raw: Record<string, unknown>): string => {
  const chunks: string[] = []
  for (const key of TEXT_KEYS) {
    const value = str(raw[key])
    if (value !== '') chunks.push(value)
  }
  for (const key of ['notes', 'commands']) for (const one of list(raw[key])) chunks.push(one)

  return chunks.join('\n').slice(0, 24000)
}

const pathTextOf = (raw: Record<string, unknown>): string => [...list(raw.touches), ...list(raw.changed), ...list(raw.outside), ...list(raw.commands)].join('\n').slice(0, 24000)

type HazardPattern = { code: JevPrecheckCode; pattern: RegExp; detail: string }

/** The lexical rules a deterministic pre-check can decide with. */
export const HAZARD_PATTERNS: HazardPattern[] = [
  { code: 'force-push', pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-f(?:\s|$))/gi, detail: 'a force push is named in the state' },
  {
    code: 'destructive-command',
    pattern: /(?:\brm\s+-[a-z]*[rf][a-z]*\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*[fd][a-z]*\b|\bdrop\s+table\b|\btruncate\s+table\b|\bmkfs(?:\.[a-z0-9]+)?\b|\bdd\s+if=|\bchmod\s+(?:-R\s+)?777\b)/gi,
    detail: 'a destructive command is named in the state',
  },
  {
    code: 'secret-path',
    pattern: /(?:^|[\s"'`(])(?:\.env(?:\.[\w.-]+)?|id_rsa|id_ed25519|\.ssh\/|credentials(?:\.json)?|secrets?\/|[\w.-]+\.pem)\b/gim,
    detail: 'a secret-bearing path is named in the state',
  },
  { code: 'hook-bypass', pattern: /(?:--no-verify|--no-gpg-sign|HUSKY=0)/gi, detail: 'a check bypass is named in the state' },
]

const AMBIGUITY = /\b(?:tbd|todo|fixme|maybe|perhaps|probably|somehow|somewhere|figure out|as needed|if needed|etc|unclear|vague|appropriate|various|later|not sure|unknown|somewhat|roughly)\b/gi

const countMatches = (text: string, pattern: RegExp): number => (text.match(new RegExp(pattern.source, pattern.flags)) ?? []).length

/** Deterministic safety codes found in the state; `policy.ts` decides what they mean. */
export const hazardCodesOf = (state: string | Record<string, unknown>): JevPrecheckCode[] => {
  const raw = rawOf(state)
  const text = textOf(raw)
  const paths = pathTextOf(raw)
  const codes: JevPrecheckCode[] = []
  for (const { code, pattern } of HAZARD_PATTERNS) {
    const scopes = code === 'secret-path' ? [text, paths] : [text]
    if (scopes.some(scope => countMatches(scope, pattern) > 0)) codes.push(code)
  }
  const outside = outsideOf(raw)
  if (outside.known && outside.value > 0) codes.push('outside-touches')
  const dirty = dirtyOf(raw)
  if (dirty.known) {
    if (num(raw.unmerged) !== undefined && (num(raw.unmerged) ?? 0) > 0) codes.push('unmerged-work')
    else if (raw.unpushed === true) codes.push('unmerged-work')
    if (dirty.value > 0 && dirty.value < 1) codes.push('dirty-work')
  }

  return [...new Set(codes)]
}

type Known = { value: number; known: boolean }

const known0 = (value: number): Known => ({ value, known: true })
const unknown = (): Known => ({ value: 0, known: false })

const outsideOf = (raw: Record<string, unknown>): Known => {
  const declared = list(raw.touches)
  const explicit = list(raw.outside)
  const changed = list(raw.changed)
  if (has(raw, 'outside') && explicit.length > 0) return known0(clamp(explicit.length / 3))
  if (!has(raw, 'changed') && !has(raw, 'outside')) return unknown()
  if (changed.length === 0) return has(raw, 'changed') ? known0(0) : unknown()
  const outside = declared.length === 0 ? 0 : changed.filter(path => !declared.some(touch => coversPath(touch, path))).length

  return known0(clamp(outside / 3))
}

const touchesUncoveredOf = (raw: Record<string, unknown>): Known => {
  const declared = list(raw.touches)
  if (!has(raw, 'touches')) return unknown()
  if (declared.length === 0) return known0(0)
  const changed = list(raw.changed)
  if (!has(raw, 'changed')) return unknown()
  const covered = declared.filter(touch => changed.some(path => coversPath(touch, path))).length

  return known0(clamp(1 - covered / declared.length))
}

const doneWhenOf = (raw: Record<string, unknown>): Known => {
  const ratio = num(raw.doneWhenMet)
  if (ratio !== undefined) return known0(clamp(1 - clamp(ratio)))
  const criteria = Array.isArray(raw.doneWhen) ? raw.doneWhen : undefined
  if (criteria === undefined) return unknown()
  if (criteria.length === 0) return known0(1)
  const met = criteria.filter(one => (isRecord(one) ? one.met === true : false)).length

  return known0(clamp(1 - met / criteria.length))
}

const evidenceOf = (raw: Record<string, unknown>): Known => {
  const present = ['status', 'summary', 'body', 'checks', 'commits'].some(key => has(raw, key))
  if (!present) return unknown()
  const checks = list(raw.checks)
  const commits = num(raw.commits) ?? 0
  const summary = str(raw.summary)
  const body = `${str(raw.body)}\n${str(raw.result)}`
  const evidence = clamp(
    (commits > 0 ? 0.2 : 0)
    + (checks.length > 0 ? 0.4 : 0)
    + (summary.length >= 20 ? 0.2 : 0)
    + (/\b(?:tests?|tested|checks?|checked|verified|verify|ran)\b/i.test(body) ? 0.2 : 0),
  )

  return known0(clamp(1 - evidence))
}

const diffOf = (raw: Record<string, unknown>): { size: Known; files: number } => {
  const diff = raw.diff
  const diffRecord = recordOf(diff)
  const lines = num(raw.diffLines) ?? num(diffRecord.lines) ?? (typeof diff === 'string' ? diff.split('\n').length : undefined)
  const files = num(raw.files) ?? num(diffRecord.files) ?? 0
  if (lines === undefined) return { size: unknown(), files }

  return { size: known0(clamp(lines / 1500)), files }
}

const reviewOf = (raw: Record<string, unknown>): Known => {
  if (!has(raw, 'reviews')) return unknown()
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : []
  if (reviews.length === 0) return known0(0.75)
  const failed = reviews.filter(one => {
    const text = isRecord(one) ? `${str(one.verdict)} ${str(one.summary)}` : str(one)

    return /\b(?:fail|failed|changes?|reject|rejected|block|blocked|request)\b/i.test(text)
  }).length

  return known0(clamp(failed / reviews.length))
}

const statusOf = (raw: Record<string, unknown>): Known => {
  const results = Array.isArray(raw.results) ? raw.results : undefined
  if (results !== undefined && results.length > 0) {
    const bad = results.filter(one => {
      const status = isRecord(one) ? str(one.status) : str(one)

      return status !== '' && status !== 'done'
    }).length

    return known0(clamp(bad / results.length))
  }
  if (!has(raw, 'status')) return unknown()
  const status = str(raw.status).toLowerCase()
  if (status === 'done') return known0(0)
  if (status === 'blocked' || status === 'failed') return known0(1)

  return known0(0.5)
}

const scopeOf = (raw: Record<string, unknown>): Known => {
  const roles = num(raw.roles) ?? (Array.isArray(raw.roles) ? raw.roles.length : undefined) ?? num(raw.roleCount)
  if (roles === undefined) return unknown()

  return known0(clamp((roles - 1) / 6))
}

const tokensOf = (text: string): Set<string> => {
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'all', 'any', 'its', 'our', 'you', 'your'])
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []

  return new Set(tokens.filter(token => !stop.has(token)))
}

/** 0..1 lexical overlap of a step against the case goal; the drift feature is its complement. */
export const overlapOf = (step: string, goal: string): number => {
  const stepTokens = tokensOf(step)
  if (stepTokens.size === 0) return 0.5
  const goalTokens = tokensOf(goal)
  if (goalTokens.size === 0) return 0.5
  let shared = 0
  for (const token of stepTokens) if (goalTokens.has(token)) shared += 1

  return shared / stepTokens.size
}

const driftOf = (raw: Record<string, unknown>): Known => {
  const overlap = num(raw.overlap)
  if (overlap !== undefined) return known0(clamp(1 - clamp(overlap)))
  const step = str(raw.step)
  const goal = str(raw.goal)
  if (step === '' || goal === '') return unknown()

  return known0(clamp(1 - overlapOf(step, goal)))
}

const dirtyOf = (raw: Record<string, unknown>): Known => {
  const present = ['dirty', 'untracked', 'unmerged', 'unpushed'].some(key => has(raw, key))
  if (!present) return unknown()
  const unmerged = num(raw.unmerged) ?? 0
  const dirty = raw.dirty
  const dirtyCount = Array.isArray(dirty) ? dirty.length : dirty === true ? 1 : 0
  const untracked = list(raw.untracked).length
  const parts = [unmerged > 0 ? 1 : 0, raw.unpushed === true ? 0.85 : 0, dirtyCount > 0 ? 0.7 : 0, untracked > 0 ? 0.6 : 0]

  return known0(clamp(Math.max(...parts)))
}

/** Extracts the documented features from one (untrusted) state. Pure and deterministic. */
export const featuresOf = (state: string | Record<string, unknown>): Featured => {
  const raw = rawOf(state)
  const text = textOf(raw)
  const paths = pathTextOf(raw)
  const hazardText = `${text}\n${paths}`
  const hazardHits = HAZARD_PATTERNS.reduce((sum, { pattern }) => sum + countMatches(hazardText, pattern), 0)
  const known = {} as JevFeatureKnown
  const features = {} as JevFeatures
  const learned = (name: JevFeatureName, result: Known): void => {
    known[name] = result.known
    features[name] = result.value
  }

  known.hazard = text !== '' || paths !== ''
  features.hazard = known.hazard ? clamp(hazardHits / 2) : 0
  known.secretPath = known.hazard
  features.secretPath = known.secretPath && countMatches(hazardText, HAZARD_PATTERNS[2]?.pattern ?? /$^/) > 0 ? 1 : 0
  learned('outsideTouches', outsideOf(raw))
  learned('touchesUncovered', touchesUncoveredOf(raw))
  learned('doneWhenGap', doneWhenOf(raw))
  learned('evidenceGap', evidenceOf(raw))
  const diff = diffOf(raw)
  learned('diffSize', diff.size)
  learned('reviewGap', reviewOf(raw))
  known.ambiguity = text !== ''
  const ambiguityHits = countMatches(text, AMBIGUITY) + countMatches(text, /\?/g)
  features.ambiguity = known.ambiguity ? clamp(ambiguityHits / 4) : 0
  learned('scope', scopeOf(raw))
  learned('statusRisk', statusOf(raw))
  learned('drift', driftOf(raw))
  learned('dirty', dirtyOf(raw))
  // A state with no structural key and no lexical evidence at all is not a
  // state we can score: answer 0.5 and let the policy ask a person.
  const informative = INFORMATIVE_KEYS.some(key => has(raw, key)) || hazardHits > 0 || ambiguityHits > 0

  return { features, known, sparse: !informative, hazards: hazardCodesOf(state) }
}

export type WeightRow = { feature: JevFeatureName; weight: number; note: string }
export type WeightTable = { base: number; rows: WeightRow[] }

/**
 * The transparent weighting table. Each feature is normalised 0..1; the risk
 * probability is `base + Σ weight × feature`, clamped to 0.01..0.99. Weights
 * are intuition, not fitted parameters: the ledger is what validates them.
 */
export const WEIGHTS: Record<JevDecisionId, WeightTable> = {
  'plan.risk': {
    base: 0.03,
    rows: [
      { feature: 'hazard', weight: 0.45, note: 'destructive commands, force pushes and secret paths in the plan' },
      { feature: 'ambiguity', weight: 0.15, note: 'vague wording that hides work' },
      { feature: 'scope', weight: 0.10, note: 'many roles / wide blast radius' },
      { feature: 'outsideTouches', weight: 0.15, note: 'named changes outside the declared touches' },
    ],
  },
  'plan.clarity': {
    base: 0.03,
    rows: [
      { feature: 'ambiguity', weight: 0.75, note: 'vague wording in the plan and its roles' },
      { feature: 'scope', weight: 0.10, note: 'more roles means more to specify' },
      { feature: 'hazard', weight: 0.10, note: 'a dangerous plan is also an under-specified one' },
    ],
  },
  'role.boundary': {
    base: 0.03,
    rows: [
      { feature: 'hazard', weight: 0.50, note: 'the brief names a destructive action or secret path' },
      { feature: 'outsideTouches', weight: 0.35, note: 'changes already outside the role\'s touches' },
      { feature: 'ambiguity', weight: 0.05, note: 'the brief is vague about what it may change' },
    ],
  },
  'result.fidelity': {
    base: 0.03,
    rows: [
      { feature: 'doneWhenGap', weight: 0.30, note: 'done-when criteria without evidence' },
      { feature: 'evidenceGap', weight: 0.25, note: 'no checks, commits or short summary to back the claim' },
      { feature: 'statusRisk', weight: 0.20, note: 'blocked or failed status' },
      { feature: 'touchesUncovered', weight: 0.15, note: 'declared touches with no change' },
      { feature: 'outsideTouches', weight: 0.10, note: 'changes outside the declared touches' },
    ],
  },
  'drift.step': {
    base: 0.04,
    rows: [
      { feature: 'drift', weight: 0.60, note: 'lexical distance between the step and the case goal' },
      { feature: 'ambiguity', weight: 0.10, note: 'vague step text' },
      { feature: 'hazard', weight: 0.05, note: 'the step names a destructive action' },
    ],
  },
  'merge.risk': {
    base: 0.03,
    rows: [
      { feature: 'hazard', weight: 0.30, note: 'dangerous commands or secret paths in the case' },
      { feature: 'outsideTouches', weight: 0.20, note: 'changes outside the declared touches' },
      { feature: 'reviewGap', weight: 0.20, note: 'no review, or a failing one' },
      { feature: 'diffSize', weight: 0.10, note: 'a large diff to merge at once' },
      { feature: 'doneWhenGap', weight: 0.10, note: 'done-when criteria without evidence' },
      { feature: 'statusRisk', weight: 0.10, note: 'unfinished role results' },
    ],
  },
  'teardown.safety': {
    base: 0.03,
    rows: [
      { feature: 'dirty', weight: 0.40, note: 'uncommitted, untracked, unmerged or unpushed work' },
      { feature: 'hazard', weight: 0.25, note: 'the teardown names a destructive command' },
      { feature: 'reviewGap', weight: 0.10, note: 'unreviewed work' },
      { feature: 'scope', weight: 0.05, note: 'many roles means more work at risk' },
    ],
  },
  'review.triage': {
    base: 0.05,
    rows: [
      { feature: 'diffSize', weight: 0.30, note: 'a large diff' },
      { feature: 'hazard', weight: 0.25, note: 'dangerous content in the diff or its notes' },
      { feature: 'scope', weight: 0.15, note: 'many changes at once' },
      { feature: 'reviewGap', weight: 0.10, note: 'earlier reviews failed' },
      { feature: 'ambiguity', weight: 0.05, note: 'vague change description' },
    ],
  },
}

export type HeuristicScore = {
  probability: number
  confidence: number
  features: JevFeatures
  known: JevFeatureKnown
  sparse: boolean
  calibration: CalibrationFit
}

/** The provider's one risk probability for a decision state, plus its provenance. */
export const scoreOf = (id: JevDecisionId, state: string | Record<string, unknown>, samples: JevSample[] = []): HeuristicScore => {
  const featured = featuresOf(state)
  const table = WEIGHTS[id]
  const calibration = fitCalibration(samples)
  if (featured.sparse) {
    return { probability: 0.5, confidence: 0.05, features: featured.features, known: featured.known, sparse: true, calibration }
  }
  let raw = table.base
  let knownWeight = 0
  let totalWeight = 0
  for (const row of table.rows) {
    totalWeight += row.weight
    if (featured.known[row.feature]) {
      knownWeight += row.weight
      raw += row.weight * featured.features[row.feature]
    }
  }
  const coverage = totalWeight === 0 ? 0 : knownWeight / totalWeight
  const confidence = clamp(0.15 + 0.7 * coverage, 0.05, 0.9)
  const probability = clamp(calibrateProbability(clamp(raw, 0.01, 0.99), calibration), 0.01, 0.99)

  return { probability, confidence, features: featured.features, known: featured.known, sparse: false, calibration }
}

export type HeuristicOptions = {
  /** Outcomes recorded in the ledger; calibration is derived from them, never assumed. */
  samples?: JevSample[] | (() => JevSample[])
  now?: () => number
}

const answersFor = (questions: JevQuestions, probability: number, confidence: number): Record<string, JevAnswer> => {
  const answers: Record<string, JevAnswer> = {}
  for (const [key, question] of Object.entries(questions)) {
    if (question.kind === 'choice') {
      const count = question.options.length
      const index = count === 0 ? 0 : Math.min(count - 1, Math.max(0, Math.floor(probability * count)))
      answers[key] = { kind: 'choice', choice: question.options[index] ?? '', confidence }
    } else answers[key] = { kind: question.kind, probability, confidence }
  }

  return answers
}

/** The offline provider: pure given the state (and the calibration samples), no network. */
export const heuristicProvider = (options: HeuristicOptions = {}): JevProvider => ({
  id: HEURISTIC_ID,
  decide: async (input: JevInput) => {
    const now = options.now ?? Date.now
    const started = now()
    const samples = typeof options.samples === 'function' ? options.samples() : (options.samples ?? [])
    const score = scoreOf(input.id, input.state, samples)
    const answers = answersFor(input.questions, score.probability, score.confidence)

    return {
      id: input.id,
      at: new Date().toISOString(),
      provider: HEURISTIC_ID,
      model: HEURISTIC_MODEL,
      stateDigest: input.stateDigest ?? digestOf(input.state),
      answers,
      latencyMs: Math.max(0, Math.round(now() - started)),
    }
  },
})
