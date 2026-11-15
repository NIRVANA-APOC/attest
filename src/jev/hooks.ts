// Orchestration facade. The lead wires the CLI and the workflow hooks to these
// functions only; everything below them (decision catalogue, policy, ledger,
// providers) is private to the Jev subsystem.
//
// Contract of the `record*` functions:
// - they append to `<commonDir>/attest/<case>/audit.jsonl` and return one outcome;
// - they never throw: a provider failure falls back to the heuristic (or to a
//   fail-safe outcome), a broken ledger never breaks orchestration, and
//   `provider: off` returns a disabled outcome without recording anything;
// - the outcome is a signal. The caller keeps its deterministic checks and its
//   gates; `blocksInEnforce` is how a gate reads a block verdict.
import { auditDecision, auditMerge, auditPlan, auditResult, auditRole, auditTeardown, questionEnabled, stateOfMerge, stateOfPlan, stateOfResult, stateOfRole, stateOfTeardown, worstOutcome } from './decisions.ts'
import type { AuditDecisionOptions, MergeAuditInput, PlanLike, ResultAuditInput, RoleAuditInput, TeardownAuditInput } from './decisions.ts'
import { digestOf, ledgerPath } from './ledger.ts'
import { loadAuditConfig } from './policy.ts'
import { riskProbabilityOf } from './probability.ts'
import { reasonFor } from './notes.ts'
import type { JevConfig, JevDecisionId, JevMode, JevOutcome } from './types.ts'

export { loadAuditConfig, DEFAULT_CONFIG } from './policy.ts'
export { runAudit } from './commands.ts'
export type { AuditCase, AuditCommandOptions, AuditRuntime } from './commands.ts'
export { auditViewOf } from './view.ts'
export { ledgerPath } from './ledger.ts'

/** `<git-common-dir>/attest/<case>/audit.jsonl` for a caller that has the two parts. */
export const ledgerPathOf = (commonDir: string, caseName: string): string => ledgerPath(commonDir, caseName)

const configOf = (config?: JevConfig): JevConfig => config ?? loadAuditConfig(undefined, process.env)

const disabledOutcome = (id: JevDecisionId, config: JevConfig): JevOutcome => ({
  id,
  at: new Date().toISOString(),
  provider: 'off',
  stateDigest: digestOf({ v: 1, kind: 'attest.jev.state/1', id, disabled: true }),
  answers: {},
  band: 'unknown',
  action: 'shadow',
  reason: reasonFor('provider.disabled', 'provider off: no calls and no audit rows; the audit stage reports disabled'),
  reasonCode: 'provider.disabled',
  latencyMs: 0,
})

const noQuestionOutcome = (id: JevDecisionId, config: JevConfig): JevOutcome => ({
  id,
  at: new Date().toISOString(),
  provider: config.provider,
  stateDigest: digestOf({ v: 1, kind: 'attest.jev.state/1', id, skipped: true }),
  answers: {},
  band: 'unknown',
  action: 'shadow',
  reason: reasonFor('policy.no-question', `the audit.questions list excludes ${id}, so nothing was asked`),
  reasonCode: 'policy.no-question',
  latencyMs: 0,
})

const failedOutcome = (id: JevDecisionId, config: JevConfig, error: unknown): JevOutcome => {
  const message = error instanceof Error ? error.message : String(error)

  return {
    id,
    at: new Date().toISOString(),
    provider: config.provider,
    stateDigest: digestOf({ v: 1, kind: 'attest.jev.state/1', id, error: message }),
    answers: {},
    band: 'high',
    action: config.mode === 'shadow' ? 'shadow' : 'ask',
    reason: reasonFor('provider.error', `${message}; fail-safe: a person decides, never an uncertain answer`),
    reasonCode: 'provider.error',
    latencyMs: 0,
    error: message,
  }
}

const options = (commonDir: string, caseName: string): AuditDecisionOptions => ({ ledger: ledgerPath(commonDir, caseName) })

const guarded = async (id: JevDecisionId, config: JevConfig, run: () => Promise<JevOutcome | undefined>): Promise<JevOutcome> => {
  if (config.provider === 'off') return disabledOutcome(id, config)
  try {
    return (await run()) ?? noQuestionOutcome(id, config)
  } catch (error) {
    return failedOutcome(id, config, error)
  }
}

const planLike = (plan: unknown): PlanLike => (typeof plan === 'object' && plan !== null && !Array.isArray(plan) ? (plan as PlanLike) : {})

export type RoleAuditRecord = { name: string; agent?: string; touches: string[]; goal?: string; text?: string; dependsOn?: string[]; planGoal?: string }
export type ResultAuditRecord = { status: string; summary: string; body: string }
export type DiffSummary = { commits: number; files: number; outside: string[] }
export type MergeAuditRecord = { results: { role: string; status: string }[]; reviews: string[]; files: number; commits: number }
export type TeardownAuditRecord = { dirty: string[]; untracked: string[]; unmerged: number; unpushed: boolean }

/** `plan.risk` + `plan.clarity`; both recorded, the riskier outcome returned. */
export const recordPlanAudit = async (commonDir: string, caseName: string, planText: string, plan: unknown, config?: JevConfig): Promise<JevOutcome> => {
  const resolved = configOf(config)

  return guarded('plan.risk', resolved, async () => {
    const state = stateOfPlan(planText, planLike(plan))
    const outcomes: JevOutcome[] = []
    if (questionEnabled(resolved, 'plan.risk')) {
      const outcome = await auditDecision('plan.risk', state, resolved, options(commonDir, caseName))
      if (outcome !== undefined) outcomes.push(outcome)
    }
    if (questionEnabled(resolved, 'plan.clarity')) {
      const outcome = await auditDecision('plan.clarity', state, resolved, options(commonDir, caseName))
      if (outcome !== undefined) outcomes.push(outcome)
    }

    return worstOutcome(outcomes)
  })
}

/** `role.boundary`, at dispatch time. */
export const recordRoleAudit = async (commonDir: string, caseName: string, role: RoleAuditRecord, config?: JevConfig): Promise<JevOutcome> => {
  const resolved = configOf(config)
  const input: RoleAuditInput = {
    name: role.name,
    ...(role.agent === undefined ? {} : { agent: role.agent }),
    ...(role.goal === undefined ? {} : { goal: role.goal }),
    brief: role.text ?? role.goal ?? '',
    touches: role.touches,
    ...(role.dependsOn === undefined ? {} : { dependsOn: role.dependsOn }),
    ...(role.planGoal === undefined ? {} : { planGoal: role.planGoal }),
  }

  return guarded('role.boundary', resolved, () => auditRole(input, resolved, options(commonDir, caseName)))
}

/** `result.fidelity`, when a role writes its result file. */
export const recordResultAudit = async (commonDir: string, caseName: string, roleName: string, result: ResultAuditRecord, diffSummary: DiffSummary, config?: JevConfig): Promise<JevOutcome> => {
  const resolved = configOf(config)
  const input: ResultAuditInput = {
    role: roleName,
    result: result.body,
    status: result.status,
    summary: result.summary,
    commits: diffSummary.commits,
    files: diffSummary.files,
    outside: diffSummary.outside,
  }

  return guarded('result.fidelity', resolved, () => auditResult(input, resolved, options(commonDir, caseName)))
}

/** `merge.risk`, before the merge gate. */
export const recordMergeAudit = async (commonDir: string, caseName: string, state: MergeAuditRecord, config?: JevConfig): Promise<JevOutcome> => {
  const resolved = configOf(config)
  const input: MergeAuditInput = { results: state.results, reviews: state.reviews, files: state.files, commits: state.commits }

  return guarded('merge.risk', resolved, () => auditMerge(input, resolved, options(commonDir, caseName)))
}

/** `teardown.safety`, before the case's worktrees and branches are removed. */
export const recordTeardownAudit = async (commonDir: string, caseName: string, state: TeardownAuditRecord, config?: JevConfig): Promise<JevOutcome> => {
  const resolved = configOf(config)
  const input: TeardownAuditInput = { dirty: state.dirty, untracked: state.untracked, unmerged: state.unmerged, unpushed: state.unpushed }

  return guarded('teardown.safety', resolved, () => auditTeardown(input, resolved, options(commonDir, caseName)))
}

/** The builders exposed for a caller that already assembled the state itself. */
export { stateOfMerge, stateOfPlan, stateOfResult, stateOfRole, stateOfTeardown }

/** One CLI-safe line: `audit plan.risk: medium 0.42 (heuristic) → ask: policy.ask.medium: …`. */
export const auditLine = (outcome: JevOutcome): string => {
  const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim()
  if (outcome.provider === 'off') return oneLine(`audit ${outcome.id}: disabled (provider off)`)
  const probability = riskProbabilityOf(outcome)
  const risk = probability === undefined ? outcome.band : `${outcome.band} ${probability.toFixed(2)}`

  return oneLine(`audit ${outcome.id}: ${risk} (${outcome.provider}) → ${outcome.action}: ${outcome.reason}`)
}

/**
 * Whether a gate must refuse. Only `enforce` + a recorded `block` says yes;
 * `ask` (including every fail-safe) means a person must decide, which is
 * `needsPersonInEnforce`, not an automatic refusal.
 */
export const blocksInEnforce = (outcome: JevOutcome, mode: JevMode): boolean => mode === 'enforce' && outcome.action === 'block'

/** Whether the outcome requires a person (enforce mode, anything but allow). */
export const needsPersonInEnforce = (outcome: JevOutcome, mode: JevMode): boolean => mode === 'enforce' && outcome.action !== 'allow'

/** The decision policy in force for a case, defaulting to shadow + heuristic. */
export const configFor = (planAudit: unknown, env: NodeJS.ProcessEnv = process.env): JevConfig => loadAuditConfig(planAudit, env)
