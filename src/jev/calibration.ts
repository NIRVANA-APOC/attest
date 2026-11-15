// Calibration: the ledger's recorded outcomes are the only evidence that a
// probability means anything. `fitCalibration` validates a recalibration map
// on a holdout split instead of assuming it helps; the heuristic provider only
// applies it when that validation passes. Nothing here claims to be the real
// TypeSafe model: a heuristic is a heuristic.
import { riskProbabilityOf } from './probability.ts'
import type { AuditOutcomeVerdict, JevSample } from './types.ts'
import type { DecisionEntry, OutcomeEntry } from './ledger.ts'

export { riskProbabilityOf } from './probability.ts'

/** Bins used by the reliability table and the audit page. */
export const BIN_COUNT = 5
/** Below this many outcomes `attest audit calibrate` says "insufficient outcomes". */
export const MIN_OUTCOMES = 5
/** Below this many observed samples the heuristic never applies a recalibration map. */
export const MIN_CALIBRATION_SAMPLES = 12

export type CalibrationBin = { lo: number; hi: number; n: number; observed: number }

export const binIndex = (p: number): number => Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(p * BIN_COUNT)))

export const emptyBins = (): CalibrationBin[] =>
  Array.from({ length: BIN_COUNT }, (_, index) => ({ lo: index / BIN_COUNT, hi: (index + 1) / BIN_COUNT, n: 0, observed: 0 }))

/** What a recorded verdict says about risk: pass/allow mean it did not materialise. */
export const observedOf = (verdict: AuditOutcomeVerdict): 0 | 1 => (verdict === 'pass' || verdict === 'allow' ? 0 : 1)

const isProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** Joins `audit-outcome` verdicts to the decisions they judge, in time order. */
export const samplesOf = (decisions: DecisionEntry[], outcomes: OutcomeEntry[]): { samples: JevSample[]; skipped: number } => {
  const samples: JevSample[] = []
  let skipped = 0
  for (const entry of outcomes) {
    const payload = entry.payload
    let decision = typeof payload.target === 'number' ? decisions.find(one => one.seq === payload.target) : undefined
    if (decision === undefined) decision = decisions.filter(one => one.outcome.id === payload.id && one.seq < entry.seq).at(-1)
    const probability = decision === undefined ? undefined : riskProbabilityOf(decision.outcome)
    if (decision === undefined || probability === undefined) {
      skipped += 1
      continue
    }
    samples.push({ id: decision.outcome.id, at: entry.at, p: probability, observed: observedOf(payload.observed) })
  }
  samples.sort((a, b) => a.at.localeCompare(b.at))

  return { samples, skipped }
}

/** Brier score over a sample set; lower is better (0.25 is always guessing 0.5). */
export const brierOf = (samples: JevSample[]): number => {
  if (samples.length === 0) return 0

  return samples.reduce((sum, sample) => sum + (sample.p - sample.observed) ** 2, 0) / samples.length
}

/** Reliability bins: n predictions per bin and the mean observed outcome in it. */
export const binsOf = (samples: JevSample[]): CalibrationBin[] => {
  const bins = emptyBins()
  const totals = bins.map(() => 0)
  for (const sample of samples) {
    const index = binIndex(sample.p)
    const bin = bins[index]
    if (bin === undefined) continue
    bin.n += 1
    totals[index] = (totals[index] ?? 0) + sample.observed
  }

  return bins.map((bin, index) => ({ ...bin, observed: bin.n === 0 ? 0 : (totals[index] ?? 0) / bin.n }))
}

export type CalibrationFit = {
  /** True only when a holdout split showed the map improves the Brier score. */
  apply: boolean
  n: number
  /** Brier score of the raw probabilities over every observed sample. */
  brierRaw: number
  /** Brier score of the mapped probabilities on the holdout split. */
  brierCalibrated: number
  /** Brier score of the raw probabilities on the same holdout split. */
  holdoutRaw: number
  reason: string
  bins: CalibrationBin[]
}

const mapWith = (p: number, bins: CalibrationBin[]): number => {
  const bin = bins[binIndex(p)]
  if (bin === undefined || bin.n < 3) return p
  // Shrink toward the raw probability: 2 pseudo-observations at p.
  return (bin.observed * bin.n + p * 2) / (bin.n + 2)
}

/**
 * Fits a reliability recalibration map and validates it on the later half of
 * the outcomes (chronological holdout). The map is applied only if it beats
 * the raw probability by a margin, so calibration is validated, not assumed.
 */
export const fitCalibration = (samples: JevSample[]): CalibrationFit => {
  const valid = samples.filter(sample => isProbability(sample.p) && (sample.observed === 0 || sample.observed === 1)).slice().sort((a, b) => a.at.localeCompare(b.at))
  const brierRaw = brierOf(valid)
  const bins = binsOf(valid)
  if (valid.length < MIN_CALIBRATION_SAMPLES) {
    return {
      apply: false, n: valid.length, brierRaw, brierCalibrated: brierRaw, holdoutRaw: brierRaw, bins,
      reason: `${valid.length} sample(s); a recalibration map is not applied below ${MIN_CALIBRATION_SAMPLES} and is never assumed to help`,
    }
  }
  const split = Math.floor(valid.length / 2)
  const train = valid.slice(0, split)
  const holdout = valid.slice(split)
  if (holdout.length < 4) {
    return { apply: false, n: valid.length, brierRaw, brierCalibrated: brierRaw, holdoutRaw: brierRaw, bins, reason: `holdout split has ${holdout.length} sample(s); need at least 4` }
  }
  const fitted = binsOf(train)
  const holdoutRaw = brierOf(holdout)
  const brierCalibrated = holdout.reduce((sum, sample) => sum + (mapWith(sample.p, fitted) - sample.observed) ** 2, 0) / holdout.length
  const apply = brierCalibrated + 0.01 < holdoutRaw

  return {
    apply,
    n: valid.length,
    brierRaw,
    brierCalibrated,
    holdoutRaw,
    bins,
    reason: apply
      ? `holdout Brier ${brierCalibrated.toFixed(3)} beats raw ${holdoutRaw.toFixed(3)} over ${holdout.length} sample(s); map applied`
      : `holdout Brier ${brierCalibrated.toFixed(3)} does not beat raw ${holdoutRaw.toFixed(3)}; raw probabilities kept`,
  }
}

/** Applies a validated calibration map to one probability; identity when unvalidated. */
export const calibrateProbability = (p: number, fit: CalibrationFit): number => (fit.apply ? mapWith(p, fit.bins) : p)

/** Advisory only, never applied automatically: where the observed outcomes disagree with the bands. */
export const thresholdAdvice = (samples: JevSample[]): string[] => {
  const bins = binsOf(samples)
  if (samples.length < MIN_OUTCOMES) return [`insufficient outcomes: ${samples.length} verdict(s) recorded, ${MIN_OUTCOMES} needed before the calibration table means anything`]
  const advice: string[] = []
  for (const bin of bins) {
    if (bin.n < 3) continue
    const midpoint = (bin.lo + bin.hi) / 2
    const gap = bin.observed - midpoint
    const range = `${bin.lo.toFixed(2)}-${bin.hi.toFixed(2)}`
    if (gap <= -0.25) advice.push(`${range}: observed ${bin.observed.toFixed(2)} vs predicted ${midpoint.toFixed(2)} over ${bin.n} outcome(s); this band over-predicts risk (advisory: recalibrate before trusting enforce mode)`)
    else if (gap >= 0.25) advice.push(`${range}: observed ${bin.observed.toFixed(2)} vs predicted ${midpoint.toFixed(2)} over ${bin.n} outcome(s); this band under-predicts risk (advisory: recalibrate before trusting enforce mode)`)
  }
  if (advice.length === 0) advice.push(`${samples.length} outcome(s) are consistent with the recorded probabilities within the reliability bins`)
  advice.push('thresholds are advisory and are never changed automatically; the heuristic provider is not the real TypeSafe model')

  return advice
}
