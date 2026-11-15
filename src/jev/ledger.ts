// The audit ledger: an append-only, hash-chained JSONL file at
// `<git-common-dir>/attest/<case>/audit.jsonl`. It is the attestation: every
// record commits to the previous one, so a later edit of any earlier record
// shows up in `verifyLedger`. No code rewrites a record; the CLI and the
// orchestrator only append whole lines.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { AuditChain, AuditOutcomeRecord, AuditOutcomeVerdict, AuditRecord, AuditRecordType, AuditVerifyPayload, JevOutcome } from './types.ts'

/** A ledger operation that cannot proceed without breaking the chain. */
export class LedgerError extends Error {}

/** `<git-common-dir>/attest/<case>/audit.jsonl`, beside the case's run log. */
export const ledgerPath = (commonDir: string, caseName: string): string => join(commonDir, 'attest', caseName, 'audit.jsonl')

const RECORD_TYPES: AuditRecordType[] = ['audit-decision', 'audit-outcome', 'audit-verify']
const VERDICTS: AuditOutcomeVerdict[] = ['allow', 'ask', 'block', 'defect', 'pass']
const SOURCES = ['gate', 'review', 'human']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** JSON with object keys sorted recursively; the exact bytes a record hash covers. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sorted(value))

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = sorted(value[key])

    return out
  }

  return value
}

export const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** `sha256:` over the canonical JSON of any value; decision states and records use it. */
export const digestOf = (value: unknown): string => sha256(canonicalJson(value))

/** The chain value of one record: `sha256:` over `{seq, at, type, prev, payload}` with sorted keys. */
export const recordHash = (record: Pick<AuditRecord, 'seq' | 'at' | 'type' | 'prev' | 'payload'>): string =>
  sha256(canonicalJson({ seq: record.seq, at: record.at, type: record.type, prev: record.prev, payload: record.payload }))

export type LedgerRead = {
  records: AuditRecord[]
  /** Lines that could not be read: a torn tail, or a hand edit. */
  unread: number
  /** The final line is an interrupted write rather than a tamper: verify reports it separately. */
  incomplete: boolean
  brokenAt?: number
  reason?: string
}

/**
 * Reads the ledger and checks the chain. A final line without a trailing
 * newline is an interrupted append (`incomplete`); anything else that fails
 * JSON, shape, sequence, link or hash is a break at that record.
 */
export const readLedger = (path: string): LedgerRead => {
  if (!existsSync(path)) return { records: [], unread: 0, incomplete: false }
  const text = readFileSync(path, 'utf8')
  const endsWithNewline = text.endsWith('\n')
  const lines = text.split('\n')
  const content = endsWithNewline ? lines.slice(0, -1) : lines
  const records: AuditRecord[] = []
  let prev = ''
  let unread = 0
  for (let index = 0; index < content.length; index += 1) {
    const line = content[index] ?? ''
    if (line.trim() === '') continue
    const last = index === content.length - 1
    const broken = (reason: string): LedgerRead => ({ records, unread, incomplete: false, brokenAt: index, reason })
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (last && !endsWithNewline) return { records, unread: unread + 1, incomplete: true }
      unread += 1

      return broken('not JSON (a hand edit, or an interrupted write with a trailing newline)')
    }
    if (!isRecord(parsed)) return broken('not a JSON object')
    const { seq, at, type, prev: link, hash, payload } = parsed
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq !== index) return broken(`seq ${String(seq)} does not follow ${index - 1}`)
    if (typeof at !== 'string' || at === '') return broken('no timestamp')
    if (typeof type !== 'string' || !RECORD_TYPES.includes(type as AuditRecordType)) return broken(`unknown type ${String(type)}`)
    if (typeof link !== 'string' || link !== prev) return broken(`prev does not link to record ${index - 1}`)
    if (typeof hash !== 'string') return broken('no hash')
    if (!isRecord(payload) && !Array.isArray(payload)) return broken('payload is not a JSON object or array')
    const record: AuditRecord = { seq, at, type: type as AuditRecordType, prev: link, hash, payload }
    const expected = recordHash(record)
    if (hash !== expected) return broken(`hash mismatch (recorded ${hash}, computed ${expected})`)
    records.push(record)
    prev = hash
  }

  return { records, unread, incomplete: false }
}

/** Chain status for the panel and for `attest audit verify`. */
export const verifyLedger = (path: string): AuditChain => {
  const read = readLedger(path)

  return {
    ok: read.brokenAt === undefined,
    length: read.records.length,
    ...(read.brokenAt === undefined ? {} : { brokenAt: read.brokenAt }),
    ...(read.incomplete ? { incomplete: true } : {}),
    ...(read.reason === undefined ? {} : { reason: read.reason }),
  }
}

const dateOf = (at: string | undefined, fallback: Date): Date => {
  if (at === undefined) return fallback
  const date = new Date(at)

  return Number.isFinite(date.getTime()) ? date : fallback
}

/** Appends one whole line, one write. Refuses when the chain is broken or ends torn. */
export const appendRecord = (path: string, type: AuditRecordType, payload: unknown, at = new Date()): AuditRecord => {
  const read = readLedger(path)
  if (read.brokenAt !== undefined) throw new LedgerError(`audit ledger is broken at record ${read.brokenAt}: ${read.reason ?? 'hash or link mismatch'}; refusing to append`)
  if (read.incomplete) throw new LedgerError('audit ledger ends with an incomplete record (an interrupted write); refusing to append rather than link past it')
  const seq = read.records.length
  const prev = read.records.at(-1)?.hash ?? ''
  const record: AuditRecord = { seq, at: at.toISOString(), type, prev, hash: '', payload }
  record.hash = recordHash(record)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`)

  return record
}

export const appendDecision = (path: string, outcome: JevOutcome, at = new Date()): AuditRecord =>
  appendRecord(path, 'audit-decision', outcome, dateOf(outcome.at, at))

export const appendOutcome = (path: string, outcome: AuditOutcomeRecord, at = new Date()): AuditRecord => {
  if (!VERDICTS.includes(outcome.observed)) throw new LedgerError(`unknown outcome verdict: ${String(outcome.observed)}`)
  if (!SOURCES.includes(outcome.source)) throw new LedgerError(`unknown outcome source: ${String(outcome.source)}`)

  return appendRecord(path, 'audit-outcome', outcome, at)
}

export const appendVerify = (path: string, payload: AuditVerifyPayload, at = new Date()): AuditRecord => appendRecord(path, 'audit-verify', payload, at)

const isOutcome = (payload: unknown): payload is JevOutcome => {
  if (!isRecord(payload)) return false
  const { id, answers, band, action, stateDigest, at } = payload

  return typeof id === 'string' && typeof answers === 'object' && answers !== null && typeof band === 'string' && typeof action === 'string'
    && typeof stateDigest === 'string' && typeof at === 'string'
}

const isOutcomeRecord = (payload: unknown): payload is AuditOutcomeRecord => {
  if (!isRecord(payload)) return false
  const { id, observed, source } = payload

  return typeof id === 'string' && typeof observed === 'string' && VERDICTS.includes(observed as AuditOutcomeVerdict) && typeof source === 'string' && SOURCES.includes(source)
}

export type DecisionEntry = { seq: number; at: string; outcome: JevOutcome }
export type OutcomeEntry = { seq: number; at: string; payload: AuditOutcomeRecord }
export type VerifyEntry = { seq: number; at: string; payload: AuditVerifyPayload }

/** The `audit-decision` records, in chain order. */
export const decisionsOf = (read: LedgerRead): DecisionEntry[] =>
  read.records.flatMap(record => (record.type === 'audit-decision' && isOutcome(record.payload) ? [{ seq: record.seq, at: record.at, outcome: record.payload }] : []))

/** The `audit-outcome` records, in chain order. */
export const outcomesOf = (read: LedgerRead): OutcomeEntry[] =>
  read.records.flatMap(record => (record.type === 'audit-outcome' && isOutcomeRecord(record.payload) ? [{ seq: record.seq, at: record.at, payload: record.payload }] : []))

export const verifiesOf = (read: LedgerRead): VerifyEntry[] =>
  read.records.flatMap(record => (record.type === 'audit-verify' && isRecord(record.payload) ? [{ seq: record.seq, at: record.at, payload: record.payload as AuditVerifyPayload }] : []))

export const readDecisions = (path: string): DecisionEntry[] => decisionsOf(readLedger(path))
export const readOutcomes = (path: string): OutcomeEntry[] => outcomesOf(readLedger(path))
export const readVerifies = (path: string): VerifyEntry[] => verifiesOf(readLedger(path))

/** The decision a `show`/`outcome` argument names: a ledger seq, or the latest decision with that id. */
export const decisionTarget = (entries: DecisionEntry[], target: string): DecisionEntry | undefined => {
  if (/^\d+$/.test(target)) return entries.find(entry => entry.seq === Number(target))
  const id = target.trim()

  return entries.filter(entry => entry.outcome.id === id).at(-1)
}
