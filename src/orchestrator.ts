import { randomUUID } from 'node:crypto'

import { AGENTS, screenOf } from './agents.ts'
import { mux } from './command-context.ts'
import type { Case, Repository, Runtime } from './command-context.ts'
import { fold, orchestratorOf, readLog } from './log.ts'
import type { Logged } from './log.ts'
import { markedPanes, markCase, orchestratorsOf, unbind } from './cases.ts'
import { tmux } from './run.ts'

export const afterMrApproval = (caseName: string): string => `Open the PR, then run attest stage merged -m ${caseName} and attest gate merged -m ${caseName} "<the PR link>". Keep the role windows: the person may ask for changes before merging.`
export const afterMerged = (caseName: string): string => `Run attest stage teardown -m ${caseName} and attest teardown -m ${caseName}, then report the cleanup.`
/** What the orchestrator does after an approved gate; the gates past the plan carry their next step. */
export const afterApproval = (gate: string, caseName: string): string => gate === 'mr-ok' ? afterMrApproval(caseName) : gate === 'merged' ? afterMerged(caseName) : 'Continue the case.'

type Target = { pane: string; token: string }
type Notice = { gate: string; at: string; text: string; target: Target }
const pending = new WeakMap<Runtime, Map<string, Notice>>()

/** Binds `pane` to case `name` as its one orchestrator; other cases' orchestrators keep their marks. */
export const markOrchestrator = (r: Runtime, repo: Repository, pane: string, name: string): void => {
  // A dead orchestrator loses the case too, so a respawned pane cannot answer for it.
  const panes = markedPanes(r, true)
  for (const other of orchestratorsOf(panes, repo, name)) if (other.pane !== pane) unbind(r, other.pane)
  const own = panes.find(one => one.pane === pane)
  const same = own?.caseName === name && own.repo === repo.common
  if (!same) markCase(r, repo, pane, name)
  if (!same || !own?.token) mux(r, ['set-option', '-p', '-t', pane, '@attest-orchestrator-token', randomUUID()])
}

/** The pane bound to this case only, with its token. */
const targets = (r: Runtime, m: Pick<Case, 'root' | 'common' | 'name'>): Target[] =>
  orchestratorsOf(markedPanes(r), m, m.name).flatMap(one => one.token ? [{ pane: one.pane, token: one.token }] : [])

/** Only answers made in this panel process are queued; the log remains authoritative. */
export const queueAnswer = (r: Runtime, m: Case, answer: Logged): void => {
  if (answer.ev !== 'gate-answer') return
  const found = targets(r, m)
  if (found.length !== 1) return
  const queue = pending.get(r) ?? new Map<string, Notice>()
  queue.set(`${m.log}\0${answer.gate}`, { gate: answer.gate, at: answer.at, target: found[0]!,
    text: (answer.answer === 'approve' ? `${answer.gate} approved in the panel. ${afterApproval(answer.gate, m.name)}` : `Change requested on ${answer.gate}: ${answer.text ?? ''}`).replace(/\s+/g, ' ').trim() })
  pending.set(r, queue)
  flushAnswers(r, m)
}

/**
 * The fallback for a case with no recorded orchestrator session (an adapter that reports none): gate answers
 * made in this panel process, typed when the pane's screen looks ready. A recorded orchestrator gets notices
 * instead (notices.ts), from the log and its own transcript.
 */
export const flushAnswers = (r: Runtime, m: Case): void => {
  const queue = pending.get(r)
  if (queue === undefined || queue.size === 0) return
  const events = readLog(m.log).events
  if (orchestratorOf(events) !== undefined) { for (const key of [...queue.keys()]) if (key.startsWith(`${m.log}\0`)) queue.delete(key); return }
  const gates = fold(events).gates
  for (const [key, notice] of queue) {
    if (!key.startsWith(`${m.log}\0`)) continue
    const gate = gates.get(notice.gate)
    if (gate?.answeredAt !== notice.at || (gate.id === 'plan' && gate.plan !== m.hash)) { queue.delete(key); continue }
    const ready = () => {
      if (!targets(r, m).some(one => one.pane === notice.target.pane && one.token === notice.target.token)) return false
      const screen = tmux(['capture-pane', '-p', '-t', notice.target.pane], r.run, r.env)

      const states = Object.values(AGENTS).map(agent => screenOf(agent, screen.out))

      return screen.code === 0 && states.includes('ready') && !states.some(state => state === 'waits' || state === 'working')
    }
    const buffer = `attest-answer-${randomUUID()}`
    let loaded = false
    try {
      if (!ready()) continue
      mux(r, ['load-buffer', '-b', buffer, '-'], { input: notice.text })
      loaded = true
      if (!ready()) continue
      mux(r, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', notice.target.pane])
      queue.delete(key)
      mux(r, ['send-keys', '-t', notice.target.pane, 'Enter'])
    } catch { /* An unavailable agent must not undo a recorded answer. */ }
    finally { if (loaded) tmux(['delete-buffer', '-b', buffer], r.run, r.env) }
  }
}
