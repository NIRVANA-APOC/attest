// Shared probability rules. The thresholds are the contract's (contracts.md
// 6.3): low `< 0.25`, medium `0.25..0.75`, high `> 0.75`. Everything that turns
// a probability into a band or reads one out of an answer set uses this file.
import type { JevAnswer, JevBand, JevOutcome } from './types.ts'

export const LOW_THRESHOLD = 0.25
export const HIGH_THRESHOLD = 0.75

const isProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

export const bandOfProbability = (probability: number | undefined): JevBand => {
  if (probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1) return 'unknown'
  if (probability < LOW_THRESHOLD) return 'low'
  if (probability > HIGH_THRESHOLD) return 'high'

  return 'medium'
}

/** The answer the policy reads as the decision's risk probability: `risk` first, then any probability. */
export const probabilityOfAnswers = (answers: Record<string, JevAnswer> | undefined): number | undefined => {
  if (answers === undefined) return undefined
  const preferred = answers.risk?.probability
  if (isProbability(preferred)) return preferred
  for (const answer of Object.values(answers)) if (isProbability(answer?.probability)) return answer.probability

  return undefined
}

/** The risk probability recorded in one outcome. */
export const riskProbabilityOf = (outcome: JevOutcome): number | undefined => probabilityOfAnswers(outcome.answers)
