// The policy engine. A provider gives probabilities and named choices; this
// module decides what they mean, and only this module may turn an answer into
// an action. Rules, in order:
//
// 1. `off` never calls anything and records nothing.
// 2. A deterministic pre-check wins whenever it can decide (destructive
//    commands, secrets, writes outside touches, lost work). It is a rule, not
//    a model, so it does not consult one.
// 3. A malformed, missing or non-finite answer fails safe: the band is high,
//    the action is `ask` in enforce mode (never `allow`) and `shadow` records it.
// 4. `shadow` records what enforce would have done and never refuses; `enforce`
//    maps low → allow, medium → ask, high → block.
//
// Answers are signals, never authorization: the caller still applies its own
// deterministic checks and gates.
import { bandOfProbability, probabilityOfAnswers } from './probability.ts'
import { hazardCodesOf, heuristicProvider } from './heuristic.ts'
import { digestOf } from './ledger.ts'
import { reasonFor } from './notes.ts'
import { typeSafeProvider } from './typesafe.ts'
import { JEV_DECISION_IDS } from './types.ts'
import type {
  JevAction, JevAnswer, JevBand, JevConfig, JevDecisionId, JevInput, JevOutcome, JevPrecheck, JevPrecheckCode,
  JevProvider, JevProviderId, JevQuestions, JevReasonCode, JevSample, LoadedJevConfig, JevMode,
} from './types.ts'

export { HIGH_THRESHOLD, LOW_THRESHOLD } from './probability.ts'

/** Contract defaults: shadow mode, offline heuristic, every question. */
export const DEFAULT_CONFIG: JevConfig = { mode: 'shadow', provider: 'heuristic' }

/** The band a probability falls in; see `probability.ts` for the thresholds. */
export const bandOf = (probability: number | undefined): JevBand => bandOfProbability(probability)

/** The enforce-mode mapping: high blocks, medium asks, low allows; unknown asks. */
export const actionOf = (band: JevBand): JevAction => {
  if (band === 'low') return 'allow'
  if (band === 'high') return 'block'

  return 'ask'
}

/** A deterministic pre-check's own verdict; `block`/`ask` are the only options. */
export const PRECHECK_DETAIL: Record<JevPrecheckCode, string> = {
  'force-push': 'state names a force push',
  'destructive-command': 'state names a destructive command',
  'secret-path': 'state names a secret-bearing path',
  'outside-touches': 'changes fall outside the declared touches',
  'hook-bypass': 'state names a check bypass (--no-verify)',
  'unmerged-work': 'unmerged or unpushed work would be lost',
  'dirty-work': 'the worktree has uncommitted or untracked work',
}

/** A clarity score is not a safety gate: destructive rules do not decide it. */
const NO_PRECHECK: JevDecisionId[] = ['plan.clarity']
const DESTRUCTIVE: JevDecisionId[] = ['plan.risk', 'role.boundary', 'result.fidelity', 'drift.step', 'merge.risk', 'teardown.safety', 'review.triage']
const SECRET: JevDecisionId[] = ['plan.risk', 'role.boundary', 'result.fidelity', 'merge.risk', 'teardown.safety', 'review.triage']
const OUTSIDE: JevDecisionId[] = ['role.boundary', 'result.fidelity', 'merge.risk']

const applies = (id: JevDecisionId, code: JevPrecheckCode): boolean => {
  if (NO_PRECHECK.includes(id)) return false
  if (code === 'force-push' || code === 'destructive-command' || code === 'hook-bypass') return DESTRUCTIVE.includes(id)
  if (code === 'secret-path') return SECRET.includes(id)
  if (code === 'outside-touches') return OUTSIDE.includes(id)
  if (code === 'unmerged-work' || code === 'dirty-work') return id === 'teardown.safety'

  return false
}

const PRECHECK_ORDER: JevPrecheckCode[] = ['force-push', 'destructive-command', 'hook-bypass', 'secret-path', 'outside-touches', 'unmerged-work', 'dirty-work']

/**
 * The first deterministic rule that can decide this question, if any. The scan
 * is done here, from the untrusted state itself: a state that merely *claims*
 * `hazards: []` cannot hide a force push from the policy.
 */
export const precheckOf = (id: JevDecisionId, state: string | Record<string, unknown>): JevPrecheck | undefined => {
  const codes = hazardCodesOf(state)
  for (const code of PRECHECK_ORDER) {
    if (!codes.includes(code) || !applies(id, code)) continue
    const action: 'block' | 'ask' = code === 'dirty-work' ? 'ask' : 'block'

    return { code, action, detail: `${PRECHECK_DETAIL[code]}; the deterministic rule decides, the model is not consulted` }
  }

  return undefined
}

/** A typed answer that does not match its question; the policy treats it as uncertainty. */
export const validateAnswers = (questions: JevQuestions, answers: Record<string, JevAnswer> | undefined): string | undefined => {
  if (answers === undefined || typeof answers !== 'object' || answers === null) return 'the provider returned no answers'
  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key] as JevAnswer | undefined
    if (answer === undefined) return `the provider returned no answer for "${key}"`
    if (answer.kind !== question.kind) return `the answer for "${key}" is not a ${question.kind}`
    if (question.kind === 'choice') {
      if (typeof answer.choice !== 'string' || !question.options.includes(answer.choice)) return `the answer for "${key}" is not one of the question's options`
    } else if (typeof answer.probability !== 'number' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
      return `the answer for "${key}" has no finite 0..1 probability`
    }
  }

  return undefined
}

const providerOf = (config: JevConfig, deps: PolicyDeps): JevProvider =>
  config.provider === 'typesafe' ? (deps.typesafe ?? typeSafeProvider({ env: deps.env })) : (deps.heuristic ?? heuristicProvider({ samples: deps.samples ?? [], ...(deps.now === undefined ? {} : { now: deps.now }) }))

export type PolicyDeps = {
  now?: () => number
  /** Recorded calibration outcomes; passed to the heuristic provider only. */
  samples?: JevSample[]
  env?: NodeJS.ProcessEnv
  /** Test seams: an explicitly provided provider is used as is. */
  heuristic?: JevProvider
  typesafe?: JevProvider
  /** False runs the model path even where a rule could decide (tests). */
  prechecks?: boolean
}

/**
 * Runs one decision through the policy. Returns `undefined` when the provider
 * is `off` (no call, no record); every other path returns an outcome, with a
 * fail-safe action rather than an exception.
 */
export const decide = async (input: JevInput, config: JevConfig, deps: PolicyDeps = {}): Promise<JevOutcome | undefined> => {
  if (config.provider === 'off') return undefined
  const now = deps.now ?? Date.now
  const started = now()
  const stateDigest = input.stateDigest ?? digestOf(input.state)
  const literal = (): JevOutcome => {
    const out: JevOutcome = { id: input.id, at: new Date(now()).toISOString(), provider: config.provider, stateDigest, answers: {}, band: 'unknown', action: 'shadow', reason: '', latencyMs: 0 }

    return out
  }
  const finish = (out: JevOutcome): JevOutcome => ({ ...out, latencyMs: Math.max(0, Math.round(now() - started)) })

  if (deps.prechecks !== false) {
    const precheck = precheckOf(input.id, input.state)
    if (precheck !== undefined) {
      const band: JevBand = precheck.action === 'block' ? 'high' : 'medium'
      const action: JevAction = config.mode === 'shadow' ? 'shadow' : precheck.action
      const code = `precheck.${precheck.code}` as JevReasonCode

      return finish({
        ...literal(), provider: 'precheck', band, action, reason: reasonFor(code, precheck.detail), reasonCode: code, precheck,
      })
    }
  }

  const heuristic = deps.heuristic ?? heuristicProvider({ samples: deps.samples ?? [], ...(deps.now === undefined ? {} : { now: deps.now }) })
  const provider = providerOf(config, { ...deps, heuristic })
  let result: Omit<JevOutcome, 'band' | 'action' | 'reason'>
  let fallbackError: string | undefined
  try {
    result = await provider.decide(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (config.provider !== 'typesafe') return finish(failSafe(literal(), config, 'provider.error', `the ${config.provider} provider failed: ${message}`, message))
    try {
      result = await heuristic.decide(input)
      fallbackError = `typesafe: ${message}`
    } catch (fallback) {
      const second = fallback instanceof Error ? fallback.message : String(fallback)

      return finish(failSafe(literal(), config, 'provider.error', `typesafe failed (${message}) and the heuristic fallback failed (${second})`, `${message}; ${second}`))
    }
  }

  const malformed = validateAnswers(input.questions, result.answers)
  if (malformed !== undefined) {
    return finish({ ...failSafe(literal(), config, 'answer.malformed', malformed, malformed), provider: result.provider, ...(result.model === undefined ? {} : { model: result.model }), answers: result.answers })
  }
  const probability = probabilityOfAnswers(result.answers)
  if (probability === undefined) {
    return finish({ ...failSafe(literal(), config, 'policy.missing-probability', 'the answer set carries no risk probability', undefined), provider: result.provider, ...(result.model === undefined ? {} : { model: result.model }), answers: result.answers })
  }
  const band = bandOf(probability)
  const enforceAction = actionOf(band)
  const action: JevAction = config.mode === 'shadow' ? 'shadow' : enforceAction
  const code: JevReasonCode = band === 'high' ? 'policy.block.high' : band === 'medium' ? 'policy.ask.medium' : 'policy.allow.low'
  const label = `${result.provider}${result.model === undefined ? '' : `/${result.model}`}`
  const detail = config.mode === 'shadow'
    ? `risk ${probability.toFixed(2)} is the ${band} band (${label}); enforce mode would ${enforceAction}; shadow records only`
    : `risk ${probability.toFixed(2)} is the ${band} band (${label}); enforce mode says ${enforceAction}`
  const outcome: JevOutcome = {
    ...literal(),
    ...result,
    id: input.id,
    at: result.at,
    stateDigest,
    band,
    action,
    reason: reasonFor(code, detail),
    reasonCode: code,
    latencyMs: 0,
    ...(fallbackError === undefined ? {} : { error: fallbackError }),
  }

  return finish(outcome)
}

const failSafe = (base: JevOutcome, config: JevConfig, code: JevReasonCode, detail: string, error: string | undefined): JevOutcome => ({
  ...base,
  provider: config.provider,
  band: 'high',
  action: config.mode === 'shadow' ? 'shadow' : 'ask',
  reason: reasonFor(code, `${detail}; fail-safe: a person decides, never an uncertain answer`),
  reasonCode: code,
  ...(error === undefined ? {} : { error }),
})

const MODES: JevMode[] = ['shadow', 'enforce']
const PROVIDERS: JevProviderId[] = ['heuristic', 'typesafe', 'off']
const AUDIT_KEYS = ['mode', 'provider', 'questions']

/**
 * The plan's `audit:` block plus the environment overrides (`ATTEST_JEV_MODE`,
 * `ATTEST_JEV_PROVIDER`). Invalid values never throw and never enable
 * enforcement accidentally: they fall back to the safe default and are
 * reported in `problems`.
 */
export const loadAuditConfig = (planAudit: unknown, env: NodeJS.ProcessEnv = process.env): LoadedJevConfig => {
  const problems: string[] = []
  let mode: JevMode = 'shadow'
  let provider: JevProviderId = 'heuristic'
  let questions: JevDecisionId[] | undefined
  if (planAudit !== undefined && planAudit !== null) {
    if (typeof planAudit !== 'object' || Array.isArray(planAudit)) problems.push('audit: is not a mapping of mode, provider and questions')
    else {
      const block = planAudit as Record<string, unknown>
      for (const key of Object.keys(block)) if (!AUDIT_KEYS.includes(key)) problems.push(`audit: unknown key "${key}" (mode, provider, questions)`)
      if (block.mode !== undefined) {
        if (typeof block.mode === 'string' && (MODES as string[]).includes(block.mode)) mode = block.mode as JevMode
        else problems.push(`audit.mode: ${JSON.stringify(block.mode)} is not shadow or enforce; shadow is used`)
      }
      if (block.provider !== undefined) {
        if (typeof block.provider === 'string' && (PROVIDERS as string[]).includes(block.provider)) provider = block.provider as JevProviderId
        else problems.push(`audit.provider: ${JSON.stringify(block.provider)} is not heuristic, typesafe or off; heuristic is used`)
      }
      if (block.questions !== undefined) {
        if (!Array.isArray(block.questions)) problems.push('audit.questions: is not a list of decision ids')
        else {
          const wanted: JevDecisionId[] = []
          for (const one of block.questions) {
            if (typeof one === 'string' && (JEV_DECISION_IDS as string[]).includes(one)) wanted.push(one as JevDecisionId)
            else problems.push(`audit.questions: ${JSON.stringify(one)} is not a decision id (${JEV_DECISION_IDS.join(', ')})`)
          }
          questions = wanted
          if (wanted.length === 0) problems.push('audit.questions: no valid decision id, so no decision runs')
        }
      }
    }
  }
  const envMode = (env.ATTEST_JEV_MODE ?? '').trim()
  if (envMode !== '') {
    if ((MODES as string[]).includes(envMode)) mode = envMode as JevMode
    else problems.push(`ATTEST_JEV_MODE: "${envMode}" is not shadow or enforce; ignored`)
  }
  const envProvider = (env.ATTEST_JEV_PROVIDER ?? '').trim()
  if (envProvider !== '') {
    if ((PROVIDERS as string[]).includes(envProvider)) provider = envProvider as JevProviderId
    else problems.push(`ATTEST_JEV_PROVIDER: "${envProvider}" is not heuristic, typesafe or off; ignored`)
  }

  return { mode, provider, ...(questions === undefined ? {} : { questions }), problems }
}
