// One case's audit summary: chain status, decision rows, band counts, the
// verdict a person reads first, and calibration derived from the ledger's own
// recorded outcomes. Shared by `attest audit report`, `auditViewOf` and the
// panel, so every surface tells the same story.
import { binsOf, brierOf, fitCalibration, MIN_OUTCOMES, samplesOf, thresholdAdvice } from './calibration.ts'
import type { CalibrationBin } from './calibration.ts'
import { decisionsOf, ledgerPath, outcomesOf, readLedger, verifyLedger } from './ledger.ts'
import type { DecisionEntry, LedgerRead, OutcomeEntry } from './ledger.ts'
import { probabilityOfAnswers } from './probability.ts'
import type { AuditChain, AuditRow, AuditView, JevBand, JevMode, JevOutcome } from './types.ts'

export type CalibrationReport = {
  n: number
  brier: number
  bins: CalibrationBin[]
  /** At least MIN_OUTCOMES verdicts: below that `calibrate` says "insufficient outcomes". */
  sufficient: boolean
  skipped: number
  fit: { apply: boolean; brierRaw: number; brierCalibrated: number; reason: string }
  suggestions: string[]
}

export type AuditCounts = { allow: number; ask: number; block: number; shadow: number }
export type AuditBands = Record<JevBand, number>

export type AuditReport = {
  case: string
  enabled: boolean
  mode: JevMode | 'off'
  provider: string
  chain: AuditChain
  counts: AuditCounts
  bands: AuditBands
  outcomes: { total: number; allow: number; ask: number; block: number; defect: number; pass: number }
  risk: AuditView['risk']
  verdict: string
  lastAt?: string
  decisions: AuditRow[]
  calibration?: CalibrationReport
  problems: string[]
  markdown: string
}

const emptyCounts = (): AuditCounts => ({ allow: 0, ask: 0, block: 0, shadow: 0 })
const emptyBands = (): AuditBands => ({ low: 0, medium: 0, high: 0, unknown: 0 })

/** The row the panel and the report show for one decision record. */
export const rowOf = (entry: DecisionEntry): AuditRow => {
  const outcome: JevOutcome = entry.outcome
  const probability = probabilityOfAnswers(outcome.answers)

  return {
    seq: entry.seq,
    id: outcome.id,
    at: outcome.at === '' ? entry.at : outcome.at,
    band: outcome.band,
    action: outcome.action,
    ...(probability === undefined ? {} : { probability }),
    provider: outcome.provider,
    reason: outcome.reason,
    ...(outcome.stateDigest === undefined ? {} : { stateDigest: outcome.stateDigest }),
  }
}

const bandRank = (band: string): number => (band === 'high' ? 3 : band === 'medium' ? 2 : band === 'low' ? 1 : 0)

export const riskOf = (rows: AuditRow[]): AuditView['risk'] => {
  let worst: AuditView['risk'] = 'unknown'
  for (const row of rows) if (bandRank(row.band) > bandRank(worst)) worst = row.band as AuditView['risk']

  return worst
}

/**
 * The one sentence the panel and the report lead with. Derived from the
 * recorded actions, not only the current config: a ledger that mixes a shadow
 * experiment and one enforced block must never claim "nothing was refused".
 */
export const verdictOf = (chain: AuditChain, counts: AuditCounts, rows: AuditRow[], mode: JevMode | 'off'): string => {
  if (chain.brokenAt !== undefined) return `chain broken at record ${chain.brokenAt}: decisions after it are unverified (${chain.reason ?? 'hash or link mismatch'})`
  if (rows.length === 0) return chain.incomplete === true ? 'no decisions recorded; the ledger ends with an interrupted write' : 'no decisions recorded yet'
  const note = chain.incomplete === true ? ' (incomplete final line ignored)' : ''
  const enforced = counts.allow + counts.ask + counts.block
  const needsPerson = counts.ask + counts.block
  if (counts.shadow > 0 && enforced > 0) {
    return `${rows.length} decision(s): ${enforced} enforced (${counts.allow} allow, ${counts.ask} ask, ${counts.block} block) and ${counts.shadow} shadow; ${needsPerson} need a person${note}`
  }
  if (enforced > 0) {
    if (counts.block > 0) return `${counts.block} decision(s) block and need a person${note}`
    if (counts.ask > 0) return `${counts.ask} decision(s) ask a person${note}`

    return `${counts.allow} decision(s) allow${note}`
  }
  if (mode === 'off') return `${rows.length} decision(s) recorded while the audit provider was off${note}`

  return `${rows.length} decision(s) recorded in shadow mode; nothing was refused${note}`
}

export const calibrationOf = (decisions: DecisionEntry[], outcomes: OutcomeEntry[]): CalibrationReport => {
  const { samples, skipped } = samplesOf(decisions, outcomes)
  const fit = fitCalibration(samples)

  return {
    n: samples.length,
    brier: brierOf(samples),
    bins: binsOf(samples),
    sufficient: samples.length >= MIN_OUTCOMES,
    skipped,
    fit: { apply: fit.apply, brierRaw: fit.brierRaw, brierCalibrated: fit.brierCalibrated, reason: fit.reason },
    suggestions: thresholdAdvice(samples),
  }
}

export type ReportHint = { mode?: JevMode; provider?: string; problems?: string[] }

/** The mode is derived from the recorded actions; a config hint only matters before any record. */
const modeOf = (rows: AuditRow[], hint: ReportHint): JevMode | 'off' => {
  if (rows.length === 0) return hint.mode ?? 'shadow'

  return rows.every(row => row.action === 'shadow') ? 'shadow' : 'enforce'
}

const providerOf = (rows: AuditRow[], hint: ReportHint): string => rows.at(-1)?.provider ?? hint.provider ?? 'heuristic'

const countsOf = (rows: AuditRow[]): AuditCounts => {
  const counts = emptyCounts()
  for (const row of rows) {
    if (row.action === 'allow' || row.action === 'ask' || row.action === 'block' || row.action === 'shadow') counts[row.action] += 1
  }

  return counts
}

const bandsOf = (rows: AuditRow[]): AuditBands => {
  const bands = emptyBands()
  for (const row of rows) if (row.band === 'low' || row.band === 'medium' || row.band === 'high' || row.band === 'unknown') bands[row.band] += 1

  return bands
}

const outcomesOfReport = (entries: OutcomeEntry[]): AuditReport['outcomes'] => {
  const counts = { total: entries.length, allow: 0, ask: 0, block: 0, defect: 0, pass: 0 }
  for (const entry of entries) {
    const observed = entry.payload.observed
    if (observed === 'allow' || observed === 'ask' || observed === 'block' || observed === 'defect' || observed === 'pass') counts[observed] += 1
  }

  return counts
}

/** The report behind `attest audit report`, `auditViewOf` and the panel. Never throws on a corrupt ledger. */
export const reportOf = (commonDir: string, caseName: string, hint: ReportHint = {}): AuditReport => {
  const path = ledgerPath(commonDir, caseName)
  const read: LedgerRead = readLedger(path)
  const chain = verifyLedger(path)
  const decisions = decisionsOf(read)
  const outcomes = outcomesOf(read)
  const rows = decisions.map(rowOf)
  const counts = countsOf(rows)
  const mode = modeOf(rows, hint)
  const provider = providerOf(rows, hint)
  const report: AuditReport = {
    case: caseName,
    enabled: rows.length > 0,
    mode,
    provider,
    chain,
    counts,
    bands: bandsOf(rows),
    outcomes: outcomesOfReport(outcomes),
    risk: riskOf(rows),
    verdict: verdictOf(chain, counts, rows, mode),
    ...(rows.at(-1) === undefined ? {} : { lastAt: rows.at(-1)?.at }),
    decisions: rows,
    ...(outcomes.length === 0 ? {} : { calibration: calibrationOf(decisions, outcomes) }),
    problems: hint.problems ?? [],
    markdown: '',
  }
  report.markdown = markdownOf(report)

  return report
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`

export const chainText = (chain: AuditChain): string => {
  if (chain.brokenAt !== undefined) return `BROKEN at record ${chain.brokenAt}${chain.reason === undefined ? '' : `: ${chain.reason}`}`
  if (chain.incomplete === true) return `OK ${chain.length} records (incomplete final line ignored)`

  return `OK ${chain.length} records`
}

const markdownTable = (rows: AuditRow[]): string[] => {
  const lines = ['| # | decision | at | band | action | risk | provider | reason |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const row of rows) lines.push(`| ${row.seq} | ${row.id} | ${row.at} | ${row.band} | ${row.action} | ${row.probability === undefined ? '—' : row.probability.toFixed(2)} | ${row.provider} | ${row.reason.replace(/\|/g, '\\|')} |`)

  return lines
}

export const markdownOf = (report: AuditReport): string => {
  const lines: string[] = [
    `# Audit: ${report.case}`, '',
    `- Chain: ${chainText(report.chain)}`,
    `- Mode: ${report.mode} · provider: ${report.provider}`,
    `- Decisions: ${report.decisions.length} · allow ${report.counts.allow} · ask ${report.counts.ask} · block ${report.counts.block} · shadow ${report.counts.shadow}`,
    `- Bands: low ${report.bands.low} · medium ${report.bands.medium} · high ${report.bands.high} · unknown ${report.bands.unknown}`,
    `- Outcomes: ${report.outcomes.total} recorded · pass ${report.outcomes.pass} · defect ${report.outcomes.defect} · allow ${report.outcomes.allow} · ask ${report.outcomes.ask} · block ${report.outcomes.block}`,
    `- Risk: ${report.risk}`,
    `- Verdict: ${report.verdict}`,
  ]
  if (report.problems.length > 0) lines.push(`- Problems: ${report.problems.join('; ')}`)
  lines.push('', '## Decisions', '')
  if (report.decisions.length === 0) lines.push('No decisions recorded.')
  else lines.push(...markdownTable(report.decisions))
  lines.push('', '## Outcomes', '')
  if (report.outcomes.total === 0) lines.push('No human or review verdicts recorded yet.')
  else lines.push(`${report.outcomes.total} verdict(s) recorded; \`attest audit calibrate\` reads them as calibration samples.`)
  lines.push('', '## Calibration', '')
  const calibration = report.calibration
  if (calibration === undefined) lines.push('No outcomes yet, so no calibration.')
  else if (!calibration.sufficient) lines.push(`insufficient outcomes: ${calibration.n} sample(s), ${MIN_OUTCOMES} needed. Calibration is not assumed; the recorded probabilities stay unvalidated.`)
  else {
    lines.push(`- Samples: ${calibration.n}${calibration.skipped > 0 ? ` (${calibration.skipped} outcome(s) had no recorded probability and were skipped)` : ''}`)
    lines.push(`- Brier score: ${calibration.brier.toFixed(3)} (0 is perfect; 0.25 is always guessing 0.5)`)
    lines.push(`- Recalibration: ${calibration.fit.apply ? 'validated on a holdout split and applied to the heuristic' : 'not applied'} — ${calibration.fit.reason}`)
    lines.push('', '| bin | n | observed |', '| --- | --- | --- |')
    for (const bin of calibration.bins) lines.push(`| ${bin.lo.toFixed(2)}–${bin.hi.toFixed(2)} | ${bin.n} | ${bin.observed.toFixed(2)} |`)
    lines.push('', '### Advisory', '')
    for (const suggestion of calibration.suggestions) lines.push(`- ${suggestion}`)
  }
  lines.push('', '## What this is', '',
    'Audit decisions are signals, never authorization: the policy engine and the deterministic pre-checks make the call, and a person still answers the gates.',
    'The heuristic provider is a deterministic offline approximation, not the real TypeSafe Jev model; its probabilities are validated only by the outcomes recorded above.',
    'The ledger is append-only and hash-chained; any edit to an earlier record shows up in `attest audit verify`.', '')

  return `${lines.join('\n')}\n`
}

export const reportJson = (report: AuditReport): Record<string, unknown> => ({
  case: report.case,
  enabled: report.enabled,
  mode: report.mode,
  provider: report.provider,
  chain: report.chain,
  counts: report.counts,
  bands: report.bands,
  outcomes: report.outcomes,
  risk: report.risk,
  verdict: report.verdict,
  ...(report.lastAt === undefined ? {} : { lastAt: report.lastAt }),
  decisions: report.decisions,
  ...(report.calibration === undefined ? {} : { calibration: report.calibration }),
  problems: report.problems,
})

export { percent }
