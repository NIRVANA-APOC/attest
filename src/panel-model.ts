import { relative } from 'node:path'

import { mux, workflowStages } from './command-context.ts'
import type { Case, Runtime } from './command-context.ts'
import { modelOf } from './model.ts'
import type { PanelModel } from './model.ts'
import { auditViewOf } from './jev/view.ts'
import type { AuditView } from './jev/types.ts'
import { PLAN_GATE } from './log.ts'
import { caseOf, Unresolved } from './cases.ts'
import { liveOf } from './role-commands.ts'
import { rootOf } from './check.ts'
import { tmux } from './run.ts'

export type Snapshot = { case: Case; model: PanelModel }
/** Before the orchestrator names its case, the panel only knows it drafts a plan, and since when (ms) when told. */
export type Reading = Snapshot | { missing: string; drafting?: { since?: number; now: number } }
/** What the panel reads while the orchestrator drafts the plan. */
export const PLANNING = 'Orch is drafting the plan'

/**
 * Whether this panel was opened for planning (`@attest-planning`, set by
 * `attest open --planning` and `attest up` to the time in ms; `1` from an
 * older attest, with no time), and since when.
 */
const planning = (r: Runtime, root: string, finish = false): { since?: number } | undefined => {
  const pane = r.env.TMUX_PANE
  if (!pane) return undefined
  const found = tmux(['display', '-p', '-t', pane, '#{@attest-panel}\t#{@attest-planning}'], r.run, r.env)
  const [panel, mark = ''] = found.code === 0 ? found.out.trimEnd().split('\t') : []
  if (panel !== root || !/^\d+$/.test(mark)) return undefined
  if (finish) mux(r, ['set-option', '-p', '-u', '-t', pane, '@attest-planning'])

  return mark === '1' ? {} : { since: Number(mark) }
}

/** The audit ledger as the Jev view projects it; a ledger that cannot be read leaves the page empty, never the panel. */
const auditOf = (common: string, name: string): AuditView | undefined => {
  try {
    return auditViewOf(common, name)
  } catch {
    return undefined
  }
}

/** The commands and panel share the same bytes, hash, stages and live reads. */
export const readPanel = (r: Runtime, want: string): Reading => {
  try {
    const m = caseOf(r, want)
    // The orchestrator drafts the plan until it first asks for approval; the mark is kept until then for its start.
    const isDrafting = !m.folded.finished && !m.folded.gates.has(PLAN_GATE)
    const marked = planning(r, m.root, !isDrafting)
    const since = marked?.since ?? Date.parse(m.events.find(e => e.ev === 'up')?.at ?? '')
    const stages = workflowStages(r, m.plan.workflow)
    const plan = { ...m.plan, problems: [...m.problems, ...stages.problems] }
    // A corrupt or unreadable ledger only costs the AUDIT page, never the rest of the panel.
    const audit = auditOf(m.common, m.name)
    const model = modelOf({
      case: m.name, planPath: relative(m.worktree, m.path), planText: m.source, plan,
      agents: m.agents, hash: m.hash, folded: m.folded, log: m.events, stages: stages.stages,
      live: new Map(m.plan.roles.map(role => [role.name, liveOf(r, m, role)])), now: new Date(r.now()),
      ...(isDrafting && { drafting: Number.isFinite(since) ? { since } : {} }),
      ...(audit !== undefined && { audit }),
    })

    return { case: m, model }
  } catch (error) {
    const why = (error as Error).message
    const waiting = error instanceof Unresolved || /^no plan for/.test(why)
    const marked = waiting ? planning(r, rootOf(r.cwd, r.run)) : undefined
    if (marked !== undefined) return { missing: PLANNING, drafting: { ...marked, now: r.now() } }
    // With cases open, an unbound panel names them instead of looking idle.
    if (error instanceof Unresolved && error.open.length > 0) return { missing: `panel: ${why}` }

    return { missing: waiting ? 'no case yet' : `panel: ${why}` }
  }
}
