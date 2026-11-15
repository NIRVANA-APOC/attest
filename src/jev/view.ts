// Read-only projection of the audit ledger for the panel. Implemented by the
// Jev subsystem; the panel imports only this shape.
import { reportOf } from './report.ts'
import type { AuditView } from './types.ts'

export type { AuditView } from './types.ts'
export type { AuditReport, CalibrationReport } from './report.ts'
export { reportOf } from './report.ts'

/**
 * The audit page's data for one case. Undefined until the ledger has records.
 * A corrupt or unreadable ledger never throws here: the chain status is the
 * report, and the panel still renders.
 */
export const auditViewOf = (commonDir: string, caseName: string): AuditView | undefined => {
  try {
    const report = reportOf(commonDir, caseName)
    if (report.chain.length === 0 && report.chain.brokenAt === undefined) return undefined
    const view: AuditView = {
      enabled: report.enabled,
      mode: report.mode,
      provider: report.provider,
      chain: report.chain,
      counts: report.counts,
      risk: report.risk,
      verdict: report.verdict,
      ...(report.lastAt === undefined ? {} : { lastAt: report.lastAt }),
      decisions: report.decisions,
      ...(report.calibration === undefined || report.calibration.n === 0
        ? {}
        : { calibration: { n: report.calibration.n, brier: report.calibration.brier, bins: report.calibration.bins.map(bin => ({ lo: bin.lo, hi: bin.hi, n: bin.n, observed: bin.observed })) } }),
    }

    return view
  } catch {
    return undefined
  }
}
