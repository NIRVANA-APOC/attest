// `attest audit` — verify, report, show, outcome and calibrate, over the one
// case ledger. The command returns a `Reply` like every other Attest command;
// it never prints directly, so the CLI, the panel and tests share one surface.
//
// Exit codes (contracts.md 7): 0 success, 1 refused/failed verification,
// 2 usage.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Refusal, Usage } from '../command-context.ts'
import type { Reply, Runtime } from '../command-context.ts'
import { MIN_OUTCOMES } from './calibration.ts'
import { calibrationOf } from './report.ts'
import type { CalibrationReport } from './report.ts'
import { appendOutcome, appendVerify, decisionTarget, decisionsOf, ledgerPath, outcomesOf, readLedger, verifyLedger } from './ledger.ts'
import { loadAuditConfig } from './policy.ts'
import { chainText, reportJson, reportOf } from './report.ts'
import type { JevConfig, JevMode } from './types.ts'

/** Everything a command needs from a case; `Case` satisfies it structurally. */
export type AuditCase = { name: string; common: string; worktree?: string }

/** Only the runtime fields the audit commands use; `Runtime` satisfies this. */
export type AuditRuntime = Pick<Runtime, 'now' | 'env'>

export type AuditCommandOptions = {
  action: string
  args?: string[]
  json?: boolean
  write?: boolean
  note?: string
  config?: JevConfig
  /** The plan's `audit:` block, read by the lead's CLI wiring when available. */
  planAudit?: unknown
}

const ACTIONS = ['verify', 'report', 'show', 'outcome', 'calibrate']
const VERDICTS = ['allow', 'ask', 'block', 'defect', 'pass']

const parseArgv = (argv: string[]): AuditCommandOptions => {
  const [action = '', ...rest] = argv
  const args: string[] = []
  let json = false
  let write = false
  let note: string | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const one = rest[index] ?? ''
    if (one === '--json') json = true
    else if (one === '--write') write = true
    else if (one === '--note') {
      note = rest.slice(index + 1).join(' ')
      index = rest.length
    } else if (one.startsWith('--note=')) note = one.slice('--note='.length)
    else args.push(one)
  }

  return { action, args, json, write, ...(note === undefined ? {} : { note }) }
}

const normalize = (options: AuditCommandOptions | string[]): AuditCommandOptions => (Array.isArray(options) ? parseArgv(options) : options)

const verify = (r: AuditRuntime, m: AuditCase, options: AuditCommandOptions): Reply => {
  const path = ledgerPath(m.common, m.name)
  const chain = verifyLedger(path)
  let appended: number | undefined
  if (chain.ok && chain.incomplete !== true && chain.length > 0) {
    try {
      const record = appendVerify(path, { ok: true, length: chain.length, by: 'cli' }, new Date(r.now()))
      appended = record.seq
    } catch {
      appended = undefined
    }
  }
  if (options.json === true) return { code: chain.ok ? 0 : 1, out: `${JSON.stringify({ ok: chain.ok, length: chain.length, ...(chain.brokenAt === undefined ? {} : { brokenAt: chain.brokenAt }), ...(chain.incomplete === true ? { incomplete: true } : {}), ...(chain.reason === undefined ? {} : { reason: chain.reason }), appended })}\n` }
  if (!chain.ok) return { code: 1, out: `BROKEN at record ${chain.brokenAt ?? '?'}: ${chain.reason ?? 'hash or link mismatch'}\n` }

  return { code: 0, out: `OK ${chain.length} records${chain.incomplete === true ? ' (incomplete final line ignored)' : ''}\n${appended === undefined ? '' : `Verify record ${appended} appended.\n`}` }
}

const report = (r: AuditRuntime, m: AuditCase, options: AuditCommandOptions): Reply => {
  const loaded = loadAuditConfig(options.planAudit, r.env)
  const config = options.config ?? loaded
  const supplied = options.config as (JevConfig & { problems?: string[] }) | undefined
  const problems = options.config === undefined ? loaded.problems : (supplied?.problems ?? [])
  // An explicit config (or plan block) is a hint; otherwise the ledger itself
  // says which mode produced the recorded actions (shadow vs enforce).
  const hint: { mode?: JevMode; provider?: string; problems: string[] } = options.config === undefined && options.planAudit === undefined
    ? { problems }
    : { mode: config.mode, provider: config.provider, problems }
  const built = reportOf(m.common, m.name, hint)
  let written: string | undefined
  let writeRefused: string | undefined
  if (options.write === true) {
    if (m.worktree === undefined) throw new Refusal('audit report --write needs a case worktree')
    const path = join(m.worktree, 'docs/cases', m.name, 'audit.md')
    if (built.chain.ok) {
      written = path
      mkdirSync(dirname(written), { recursive: true })
      writeFileSync(written, built.markdown)
    } else writeRefused = `refusing to write ${path}: the audit chain is broken at record ${built.chain.brokenAt ?? '?'}`
  }
  const code = built.chain.ok ? 0 : 1
  if (options.json === true) return { code, out: `${JSON.stringify({ ...reportJson(built), ...(written === undefined ? {} : { written }), ...(writeRefused === undefined ? {} : { writeRefused }) })}\n` }
  const out = `${built.markdown}${written === undefined ? '' : `\nWrote ${written}\n`}${writeRefused === undefined ? '' : `\n${writeRefused}\n`}`

  return { code, out }
}

const show = (m: AuditCase, options: AuditCommandOptions): Reply => {
  const target = options.args?.[0]
  if (target === undefined || target === '') throw new Usage('audit show <n>')
  const read = readLedger(ledgerPath(m.common, m.name))
  const entry = decisionTarget(decisionsOf(read), target)
  if (entry === undefined) throw new Refusal(`no audit decision ${target} for case ${m.name}`)
  if (options.json === true) return { code: 0, out: `${JSON.stringify({ seq: entry.seq, ...entry.outcome })}\n` }
  const outcome = entry.outcome
  const probability = outcome.answers.risk?.probability
  const answers = Object.entries(outcome.answers).map(([key, answer]) => `${key}: ${answer.kind}${answer.probability === undefined ? '' : ` ${answer.probability.toFixed(2)}`}${answer.choice === undefined ? '' : ` ${answer.choice}`}${answer.confidence === undefined ? '' : ` (confidence ${answer.confidence.toFixed(2)})`}`)
  const lines = [
    `seq ${entry.seq} · ${outcome.id} · ${outcome.at || entry.at}`,
    `band ${outcome.band} · action ${outcome.action} · provider ${outcome.provider}${outcome.model === undefined ? '' : `/${outcome.model}`} · risk ${probability === undefined ? '—' : probability.toFixed(2)}`,
    `state ${outcome.stateDigest}`,
    `reason ${outcome.reason}`,
    ...(answers.length === 0 ? [] : [`answers ${answers.join(' · ')}`]),
    ...(outcome.error === undefined ? [] : [`error ${outcome.error}`]),
  ]

  return { code: 0, out: `${lines.join('\n')}\n` }
}

const outcome = (r: AuditRuntime, m: AuditCase, options: AuditCommandOptions): Reply => {
  const [target, verdict] = options.args ?? []
  if (target === undefined || verdict === undefined) throw new Usage('audit outcome <id|seq> <allow|ask|block|defect|pass> [--note text]')
  if (!VERDICTS.includes(verdict)) throw new Usage(`audit outcome verdict must be one of ${VERDICTS.join(', ')}`)
  const path = ledgerPath(m.common, m.name)
  const entry = decisionTarget(decisionsOf(readLedger(path)), target)
  if (entry === undefined) throw new Refusal(`no audit decision ${target} for case ${m.name}`)
  const payload = {
    id: entry.outcome.id,
    target: entry.seq,
    expected: entry.outcome.action,
    observed: verdict as 'allow' | 'ask' | 'block' | 'defect' | 'pass',
    source: 'human' as const,
    ...(options.note === undefined ? {} : { note: options.note }),
  }
  const record = appendOutcome(path, payload, new Date(r.now()))
  if (options.json === true) return { code: 0, out: `${JSON.stringify({ seq: record.seq, payload })}\n` }

  return { code: 0, out: `Recorded outcome for ${payload.id} (seq ${entry.seq}): expected ${payload.expected}, observed ${payload.observed}${options.note === undefined ? '' : ` · ${options.note}`}\n` }
}

const calibrationLines = (calibration: CalibrationReport): string[] => {
  const lines = [
    `Calibration: ${calibration.n} sample(s)${calibration.skipped === 0 ? '' : ` (${calibration.skipped} outcome(s) without a recorded probability skipped)`}`,
    `Brier score: ${calibration.brier.toFixed(3)} (0 is perfect; 0.25 is always guessing 0.5)`,
    `Recalibration: ${calibration.fit.apply ? 'validated on a holdout split and applied to the heuristic' : 'not applied'} — ${calibration.fit.reason}`,
    '',
    'reliability bins (predicted → observed):',
    ...calibration.bins.map(bin => `  ${bin.lo.toFixed(2)}–${bin.hi.toFixed(2)}  n ${String(bin.n).padStart(2)}  observed ${bin.n === 0 ? '—' : bin.observed.toFixed(2)}`),
    '',
    'advisory:',
    ...calibration.suggestions.map(suggestion => `  - ${suggestion}`),
  ]

  return lines
}

const calibrate = (m: AuditCase, options: AuditCommandOptions): Reply => {
  const read = readLedger(ledgerPath(m.common, m.name))
  const calibration = calibrationOf(decisionsOf(read), outcomesOf(read))
  if (!calibration.sufficient) {
    const message = `insufficient outcomes: ${calibration.n} sample(s) for case ${m.name}; at least ${MIN_OUTCOMES} verdicts are needed before calibration means anything.\nRecord them with \`attest audit outcome <id> <allow|ask|block|defect|pass>\`.\n`
    if (options.json === true) return { code: 0, out: `${JSON.stringify({ case: m.name, ...calibration })}\n` }

    return { code: 0, out: message }
  }
  if (options.json === true) return { code: 0, out: `${JSON.stringify({ case: m.name, ...calibration })}\n` }

  return { code: 0, out: `${calibrationLines(calibration).join('\n')}\n` }
}

/**
 * Runs one `attest audit` action. Accepts either a parsed options object (the
 * lead's CLI wiring) or a raw argv array (`runAudit(r, m, ['verify'])`).
 */
export const runAudit = async (r: AuditRuntime, m: AuditCase, options: AuditCommandOptions | string[]): Promise<Reply> => {
  const normalized = normalize(options)
  if (!ACTIONS.includes(normalized.action)) throw new Usage(`audit ${normalized.action || '<action>'}: choose ${ACTIONS.join(', ')}`)
  if (normalized.action !== 'show' && normalized.action !== 'outcome' && (normalized.args?.length ?? 0) > 0) throw new Usage(`audit ${normalized.action} takes no arguments`)
  switch (normalized.action) {
    case 'verify':
      return verify(r, m, normalized)
    case 'report':
      return report(r, m, normalized)
    case 'show':
      return show(m, normalized)
    case 'outcome':
      return outcome(r, m, normalized)
    default:
      return calibrate(m, normalized)
  }
}

/** The chain line a person or CI reads first, without running the command. */
export const chainLineOf = (commonDir: string, caseName: string): string => chainText(verifyLedger(ledgerPath(commonDir, caseName)))
