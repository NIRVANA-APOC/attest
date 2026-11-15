// The stable reason-code table. Every audit outcome carries a code (machine
// readable, safe to show in the panel and in reports) and a human sentence.
// Codes are part of the product surface: add new ones here before using them.
import type { JevReasonCode } from './types.ts'

export type ReasonNote = { label: string; detail: string }

/** Every code the policy engine can emit, with what it means. */
export const REASONS: Record<JevReasonCode, ReasonNote> = {
  'policy.allow.low': {
    label: 'allow (low risk)',
    detail: 'the decision probability is below the low threshold; in enforce mode the policy allows',
  },
  'policy.ask.medium': {
    label: 'ask (medium risk)',
    detail: 'the decision probability is between the thresholds; in enforce mode a person is asked',
  },
  'policy.block.high': {
    label: 'block (high risk)',
    detail: 'the decision probability is above the high threshold; in enforce mode the policy blocks',
  },
  'policy.shadow': {
    label: 'shadow',
    detail: 'shadow mode records what enforce would have done and never refuses',
  },
  'policy.fail-safe': {
    label: 'fail-safe',
    detail: 'no usable answer; policy asks a person and never allows on an uncertain answer',
  },
  'policy.missing-probability': {
    label: 'fail-safe: no probability',
    detail: 'the provider answered without a finite 0..1 probability; treated as uncertain',
  },
  'policy.no-question': {
    label: 'no question selected',
    detail: "the plan's audit.questions list excludes this decision, so nothing was asked",
  },
  'provider.disabled': {
    label: 'audit disabled',
    detail: 'provider off: no calls and no audit rows; the audit stage reports disabled',
  },
  'provider.error': {
    label: 'provider error',
    detail: 'the provider failed and no fallback answer was available; a person must decide',
  },
  'provider.fallback': {
    label: 'provider fallback',
    detail: 'the configured provider failed; the deterministic heuristic answered instead and the error is recorded',
  },
  'answer.malformed': {
    label: 'malformed answer',
    detail: 'the provider answer did not match the typed question; treated as uncertain',
  },
  'precheck.force-push': {
    label: 'pre-check: force push',
    detail: 'a force push was named; the deterministic rule decides and the model is not consulted',
  },
  'precheck.destructive-command': {
    label: 'pre-check: destructive command',
    detail: 'a destructive command was named; the deterministic rule decides and the model is not consulted',
  },
  'precheck.secret-path': {
    label: 'pre-check: secret path',
    detail: 'a secret-bearing path was named; the deterministic rule decides and the model is not consulted',
  },
  'precheck.outside-touches': {
    label: 'pre-check: outside touches',
    detail: 'changes outside the role\'s declared touches were named; the deterministic rule decides',
  },
  'precheck.hook-bypass': {
    label: 'pre-check: hook bypass',
    detail: 'a check bypass (--no-verify) was named; the deterministic rule decides and the model is not consulted',
  },
  'precheck.unmerged-work': {
    label: 'pre-check: unmerged work',
    detail: 'unmerged or unpushed work would be lost; the deterministic rule decides',
  },
  'precheck.dirty-work': {
    label: 'pre-check: dirty worktree',
    detail: 'the worktree has uncommitted work; a person decides whether it may be discarded',
  },
}

export const REASON_CODES = Object.keys(REASONS) as JevReasonCode[]

/** `code: human sentence`, the `JevOutcome.reason` format. */
export const reasonFor = (code: JevReasonCode, detail: string): string => `${code}: ${detail}`

/** The code part of a reason string, for tolerant readers of old ledgers. */
export const reasonCodeOf = (reason: string): string => reason.split(':', 1)[0] ?? reason
