import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import pc from 'picocolors'

import { check } from './check.ts'
import { langOf, WRITE_CHINESE } from './i18n.ts'
import { clean, mux, NAME, Refusal, repository, runtime, Usage, workflowStages } from './command-context.ts'
import type { Case, Reply, Runtime } from './command-context.ts'
import { append, fold, logPath, PLAN_GATE, readLog } from './log.ts'
import { callerOf, dropCase, finished, heldBy, markedPanes, caseOf, caseList, newCase, planOf, resolveCase, Unresolved } from './cases.ts'
import { createPane, ownedPane } from './panes.ts'
import { close, dispatch, send, statusOf, teardown, turnOf, waitsOnOf } from './role-commands.ts'
import { available, installSkill, setup, skillTarget } from './setup.ts'
import { readResult } from './state.ts'
import { tmux } from './run.ts'
import { panel } from './panel.ts'
import { recordOrchestrator } from './notices.ts'
import { afterApproval, markOrchestrator } from './orchestrator.ts'
import { createPanel, openPanel } from './panel-open.ts'
import {
  auditLine, blocksInEnforce, loadAuditConfig, needsPersonInEnforce, recordMergeAudit, recordPlanAudit,
  recordResultAudit, recordRoleAudit, recordTeardownAudit, runAudit,
} from './jev/hooks.ts'
import type { JevConfig } from './jev/types.ts'

const OPTIONS: Record<string, string[]> = {
  setup: ['remove'], open: ['planning'], up: ['orch'], case: ['base'], check: [], approve: [], gate: ['no-wait'], stage: [],
  dispatch: [], status: ['json', 'watch'], send: [], wait: ['role', 'gate', 'timeout', 'ready'], teardown: ['force'], close: ['all'], panel: ['once', 'plain', 'width', 'height', 'no-anim'], audit: ['json', 'write', 'note'],
}

const parsed = (command: string, args: string[]) => {
  if (OPTIONS[command] === undefined) throw new Usage(`unknown command '${command}'`)
  let result
  try {
    result = parseArgs({ args, allowPositionals: true, options: {
      case: { type: 'string', short: 'm' }, remove: { type: 'boolean' }, orch: { type: 'string' },
      'no-wait': { type: 'boolean' }, json: { type: 'boolean' }, watch: { type: 'boolean' },
      ready: { type: 'boolean' }, force: { type: 'boolean' },
      planning: { type: 'boolean' }, base: { type: 'string' },
      role: { type: 'string' }, gate: { type: 'string' }, timeout: { type: 'string' }, all: { type: 'boolean' },
      once: { type: 'boolean' }, plain: { type: 'boolean' }, 'no-anim': { type: 'boolean' }, width: { type: 'string' }, height: { type: 'string' },
      write: { type: 'boolean' }, note: { type: 'string' },
    } })
  } catch (error) {
    throw new Usage((error as Error).message)
  }
  for (const key of Object.keys(result.values)) if (key !== 'case' && !OPTIONS[command]?.includes(key)) throw new Usage(`--${key} is not an option for ${command}`)
  if (result.values.case !== undefined && !NAME.test(result.values.case)) throw new Usage('case must be a folder name under docs/cases')

  return result
}

const count = (args: string[], min: number, max: number, usage: string): void => {
  if (args.length < min || args.length > max) throw new Usage(usage)
}
const id = (value: string | undefined, what: string): string => {
  if (value === undefined || !NAME.test(value)) throw new Usage(`${what} must be a name of letters, digits, - or _`)

  return value
}

/** The case's Jev configuration: its plan block, overridden by the environment. */
const auditConfig = (r: Runtime, m: Case): JevConfig => loadAuditConfig(m.plan.audit, r.env)

/** Colour only a real terminal: tests and pipes see byte-identical plain text. */
const paint = (r: Runtime, style: (text: string) => string, text: string): string => (r.outputTTY && process.stdout.isTTY ? style(text) : text)

/** A pending-person decision stops the action in enforce mode; shadow only records. */
const audited = (outcome: Awaited<ReturnType<typeof recordPlanAudit>>, config: JevConfig, what: string): void => {
  if (needsPersonInEnforce(outcome, config.mode)) throw new Refusal(`${what}: ${auditLine(outcome)}`)
}

/** What teardown would discard, read before the command removes anything. */
const teardownState = (r: Runtime, m: Case): { dirty: string[]; untracked: string[]; unmerged: number; unpushed: boolean } => {
  const dirty: string[] = []
  const untracked: string[] = []
  const trees = [m.worktree, ...[...m.folded.roles.values()].map(role => role.worktree)].filter(worktree => existsSync(worktree))
  for (const worktree of trees) {
    const status = r.run('git', ['status', '--porcelain'], { cwd: worktree })
    if (status.code !== 0) continue
    for (const line of status.out.split('\n')) {
      if (line.trim() === '') continue
      if (line.startsWith('?? ')) untracked.push(`${worktree}: ${line.slice(3)}`)
      else dirty.push(`${worktree}: ${line.slice(3)}`)
    }
  }
  const base = m.plan.base || `case/${m.name}`
  const ahead = r.run('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: m.worktree })
  const unmerged = ahead.code === 0 ? Number(ahead.out.trim()) || 0 : 0
  const upstream = r.run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: m.worktree })
  let unpushed = false
  if (upstream.code === 0 && upstream.out.trim() !== '') {
    const count = r.run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: m.worktree })
    unpushed = count.code === 0 && (Number(count.out.trim()) || 0) > 0
  }

  return { dirty, untracked, unmerged, unpushed }
}

const approve = async (r: Runtime, m: Case): Promise<Reply> => {
  const show = [m.plan.goal, ...m.plan.roles.map(role => `${role.name}: ${role.agent} / ${role.model || 'default'} / ${role.effort || 'default'} / flags ${JSON.stringify(role.flags)}`), m.hash, `Problems: ${m.problems.join('; ') || 'none'}`].join('\n')
  r.write(`${show}\n`)
  clean(m)
  if (!/^y(?:es)?$/i.test((await r.ask('Approve? [y/N] ')).trim())) return { code: 1, out: 'Not approved.\n' }
  const current = caseOf(r, m.name)
  clean(current)
  if (current.hash !== m.hash) throw new Refusal('the plan or referenced text changed while approval was open; approve again')
  append(m.log, 'cli', { ev: 'gate-answer', gate: PLAN_GATE, answer: 'approve', plan: m.hash })

  return { code: 0, out: `Approved ${m.name} (${m.hash})\n` }
}

const wait = async (r: Runtime, m: Case, target: { role?: string; gate?: string; seconds?: number; ready?: boolean }): Promise<Reply> => {
  const until = target.seconds === undefined ? Infinity : r.now() + target.seconds * 1000
  for (;;) {
    if (r.signal?.aborted) return { code: 1, out: 'Wait cancelled.\n' }
    const read = readLog(m.log)
    if (read.unread > 0) throw new Refusal(`${m.log}: unread log lines; cannot wait reliably`)
    const folded = fold(read.events)
    if (target.gate !== undefined) {
      const answer = folded.gates.get(target.gate)
      if (answer?.answer !== undefined) return { code: 0, out: answer.answer === 'approve'
        ? `approve\n${target.gate === 'mr-ok' || target.gate === 'merged' ? `${afterApproval(target.gate, m.name)}\n` : ''}` : `change: ${answer.text ?? ''}\n` }
    } else {
      const opened = folded.roles.get(target.role ?? '')
      if (opened === undefined) throw new Refusal(`role ${target.role}: not dispatched`)
      const result = target.ready ? undefined : readResult(opened.worktree)
      if (!target.ready && result?.status) {
        const role = statusOf(r, m).roles.find(one => one.name === target.role)
        const config = auditConfig(r, m)
        const outcome = await recordResultAudit(m.common, m.name, target.role ?? '', { status: result.status, summary: result.summary, body: result.body }, {
          commits: role?.commits.length ?? 0, files: role?.changed.length ?? 0, outside: role?.outside ?? [],
        }, config)
        if (needsPersonInEnforce(outcome, config.mode)) return { code: 1, out: `${result.status}: ${result.summary}\n${auditLine(outcome)}\n` }
        return { code: result.status === 'done' ? 0 : 1, out: `${result.status}: ${result.summary}\n` }
      }
      const pane = ownedPane(r, opened)
      if (opened.closed || !pane.alive || pane.dead) return { code: 1, out: `${target.role}: pane gone without a result\n` }
      if (target.ready) {
        const role = m.plan.roles.find(role => role.name === target.role)
        const agent = m.agents[opened.agent ?? role?.agent ?? '']
        if (agent === undefined || agent.command !== opened.argv[0]) throw new Refusal(`role ${target.role}: its launched adapter cannot be resolved`)
        const screen = turnOf(r, agent, opened, pane.screen)
        if (screen === 'ready') return { code: 0, out: `${target.role}: ready\n` }
        if (screen === 'waits') return { code: 1, out: `${target.role}: waits on you\n${waitsOnOf(agent, pane.screen) ?? ''}\n` }
      }
    }
    if (r.now() >= until) return { code: 1, out: `Timed out waiting for ${target.role === undefined ? `gate ${target.gate}` : `role ${target.role}`}\n` }
    await r.sleep(Math.min(2000, until - r.now()))
  }
}

const stage = async (r: Runtime, m: Case, name: string): Promise<Reply> => {
  const read = workflowStages(r, m.plan.workflow)
  if (read.problems.length > 0) throw new Refusal(read.problems.join('\n'))
  if (!read.stages.some(stage => stage.id === name)) throw new Refusal(`unknown stage ${name}; choose ${read.stages.map(stage => stage.id).join(', ')}`)
  // The audit stage is a check, not just a marker: verify the chain, decide on
  // every finished role's result, and write the report before the stage moves.
  // A broken chain or an enforce-mode block leaves the stage where it was.
  if (name === 'audit') return auditStage(r, m)
  append(m.log, 'cli', { ev: 'stage', stage: name })

  return { code: 0, out: `Stage: ${name}\n` }
}

/** Runs the workflow's audit stage: chain verify, one fidelity decision per result, then the report. */
const auditStage = async (r: Runtime, m: Case): Promise<Reply> => {
  const config = auditConfig(r, m)
  const verify = await runAudit(r, m, { action: 'verify', planAudit: m.plan.audit })
  if (verify.code !== 0) return verify
  const lines: string[] = []
  const view = statusOf(r, m)
  for (const role of m.plan.roles) {
    const opened = m.folded.roles.get(role.name)
    if (opened === undefined) continue
    const result = readResult(opened.worktree)
    if (result?.status === undefined) continue
    const one = view.roles.find(entry => entry.name === role.name)
    const outcome = await recordResultAudit(m.common, m.name, role.name, { status: result.status, summary: result.summary, body: result.body }, {
      commits: one?.commits.length ?? 0, files: one?.changed.length ?? 0, outside: one?.outside ?? [],
    }, config)
    if (needsPersonInEnforce(outcome, config.mode)) return { code: 1, out: `${lines.join('')}${auditLine(outcome)}\n` }
    lines.push(`${auditLine(outcome)}\n`)
  }
  const report = await runAudit(r, m, { action: 'report', write: true, json: true, planAudit: m.plan.audit })
  if (report.code !== 0) return report
  let written = ''
  try {
    const data = JSON.parse(report.out) as { written?: string; counts?: { allow?: number; ask?: number; block?: number; shadow?: number }; risk?: string }
    const counts = data.counts ?? {}
    written = `Audit report: ${data.written ?? 'written'} · risk ${data.risk ?? 'unknown'} · allow ${counts.allow ?? 0} · ask ${counts.ask ?? 0} · block ${counts.block ?? 0} · shadow ${counts.shadow ?? 0}\n`
  } catch { written = 'Audit report written.\n' }
  append(m.log, 'cli', { ev: 'stage', stage: 'audit' })

  return { code: 0, out: `Stage: audit\n${verify.out}${lines.join('')}${written}` }
}

const listing = (r: Runtime, json: boolean): string => {
  const cases = caseList(r, repository(r))
  if (json) return `${JSON.stringify({ cases })}\n`

  return cases.length === 0 ? 'No open cases.\n'
    : cases.map(one => `${one.name} · ${one.worktree || 'no worktree'} · orchestrator ${one.orchestrator || '—'} · panel ${one.panel || '—'}`).join('\n') + '\n'
}

/** One case's roles, or, when none resolves for the caller, every open case. */
const status = async (r: Runtime, want: string, json: boolean, watch: boolean): Promise<Reply> => {
  for (;;) {
    let out: string
    let code = 0
    try {
      let name = want
      if (name === '') try { name = resolveCase(r, repository(r), '') } catch (error) { if (!(error instanceof Unresolved)) throw error }
      if (name === '') out = listing(r, json)
      else {
        const view = statusOf(r, caseOf(r, name))
        code = view.problems.length > 0 ? 1 : 0
        out = json ? `${JSON.stringify(view)}\n` : [
          `${view.case} · stage ${view.stage || '—'}`,
          ...view.roles.map(role => {
            const state = role.state === 'done' ? paint(r, pc.green, role.state)
              : role.state === 'working' ? paint(r, pc.cyan, role.state)
                : role.state === 'waits' || role.state === 'blocked' || role.state === 'failed' ? paint(r, pc.red, role.state)
                  : paint(r, pc.dim, role.state)

            return `${role.name}: ${state} · ${role.agent} · ${role.branch || '—'} · ${role.commits.length} commits · changed ${role.changed.join(', ') || '—'} · outside ${role.outside.join(', ') || '—'}${role.summary ? ` · ${role.summary}` : ''}${role.problem ? ` · ${role.problem}` : ''}`
          }),
          ...view.gates.map(gate => `Gate ${gate.id}: ${gate.ask || 'needs you'}`),
          ...view.problems,
        ].join('\n') + '\n'
      }
    } catch (error) {
      if (!watch) throw error
      out = `${(error as Error).message}\n`
      code = 1
    }
    if (!watch) return { code, out }
    r.write(`${r.outputTTY && !json ? '\x1b[2J\x1b[H' : ''}${out}`)
    if (r.signal?.aborted) return { code: 0, out: '' }
    await r.sleep(2000)
  }
}

/** `attest case new <m>`: the case's worktree and plan, bound to the caller pane, with its panel. */
const caseNew = (r: Runtime, name: string, base: string): Reply => {
  const repo = repository(r)
  const caller = callerOf(r)
  const held = caller === undefined ? { name: '', root: '' } : heldBy(r, markedPanes(r), caller)
  if (held.name !== '') throw new Refusal(`this pane runs case ${held.name}${held.root === repo.root ? '' : ` in ${held.root}`}; start ${name} from another pane`)
  const worktree = newCase(r, repo, name, base)
  if (caller !== undefined) markOrchestrator(r, repo, caller, name)
  const opened = available(r, 'tmux') ? openPanel(r, name).out : ''

  const language = langOf(r.home, r.env) === 'zh' ? `${WRITE_CHINESE}\n` : ''

  return { code: 0, out: `Case ${name}: ${worktree} on case/${name}\n${language}${opened}` }
}

/** `attest up -m <m>`: a new case, with its orchestrator working in the case worktree and its panel beside it. */
const up = (r: Runtime, want: string, orch: string): Reply => {
  if (want === '') throw new Refusal('up starts a new case: pass -m <case>')
  if (!available(r, 'tmux')) throw new Refusal('tmux is required for attest up')
  if (!available(r, orch)) throw new Refusal(`${orch} was not found on PATH`)
  let installed = ''
  if (!existsSync(join(skillTarget(r, orch), 'SKILL.md'))) installed = installSkill(r, orch)
  const repo = repository(r)
  const worktree = newCase(r, repo, want, '')
  let opened
  let panel
  try {
    opened = createPane(r, repo, 'case', worktree, [orch])
    markOrchestrator(r, repo, opened.pane, want)
    panel = createPanel(r, repo, want, opened.pane, opened, 50, true)
    append(logPath(repo.common, want), 'cli', { ev: 'up', session: opened.session, window: opened.window, pane: opened.pane, panel: panel.pane })
  } catch (error) {
    if (panel !== undefined && ownedPane(r, panel).alive) tmux(['kill-pane', '-t', panel.pane], r.run, r.env)
    if (opened !== undefined && ownedPane(r, opened).alive) tmux(['kill-pane', '-t', opened.pane], r.run, r.env)
    dropCase(r, repo, want, worktree)
    throw error
  }
  mux(r, ['select-pane', '-t', opened.pane])
  mux(r, ['select-window', '-t', opened.window])
  if (!r.env.TMUX) mux(r, ['attach-session', '-t', opened.session], { inherit: true })

  return { code: 0, out: `${installed}Opened case window ${opened.window}; ${orch} orchestrator ${opened.pane} in ${worktree}, status ${panel.pane}\n` }
}

export const execute = async (command: string, args: string[], overrides: Partial<Runtime> = {}): Promise<Reply> => {
  const r = runtime(overrides)
  try {
    const { values, positionals: pos } = parsed(command, args)
    const want = values.case ?? ''
    if (command === 'panel') {
      count(pos, 0, 0, 'panel [-m case] [--once] [--plain] [--no-anim] [--width N --height N]')
      const size = (value: string | undefined, name: string): number | undefined => {
        if (value === undefined) return undefined
        const n = Number(value)
        if (!Number.isSafeInteger(n) || n < 1) throw new Usage(`--${name} must be a positive integer`)

        return n
      }

      return await panel(r, { case: want, once: values.once, plain: values.plain, width: size(values.width, 'width'), height: size(values.height, 'height'), noAnim: values['no-anim'] })
    }
    if (command === 'setup') {
      count(pos, 0, 0, 'setup [--remove]')
      return setup(r, values.remove)
    }
    if (command === 'open') {
      count(pos, 0, 0, 'open [-m case] [--planning]')
      return openPanel(r, want, !!values.planning)
    }
    if (command === 'case') {
      if (pos[0] !== 'new') throw new Usage('case new <name> [--base <ref>]')
      count(pos, 2, 2, 'case new <name> [--base <ref>]')
      if (values.case !== undefined) throw new Usage('case new takes the name as its argument, not -m')
      return caseNew(r, id(pos[1], 'case'), values.base ?? '')
    }
    if (command === 'up') {
      count(pos, 0, 0, 'up -m <case> [--orch claude|codex]')
      const orch = values.orch ?? (available(r, 'claude') ? 'claude' : available(r, 'codex') ? 'codex' : 'claude')
      if (!['claude', 'codex'].includes(orch)) throw new Usage('--orch must be claude or codex')
      return up(r, want, orch)
    }
    if (command === 'check') {
      count(pos, 0, want ? 0 : 1, 'check [-m case | plan file or folder]')
      if (pos[0] !== undefined) return check(r.cwd, pos[0], r.home, r.run)
      // The resolved case's plan, read in its worktree.
      const repo = repository(r)
      let name
      try { name = resolveCase(r, repo, want) } catch (error) { if (error instanceof Unresolved) return { code: 2, out: `attest check: ${error.message}\n` }; throw error }
      return check(r.cwd, planOf(r, repo, name) ?? join('docs/cases', name, 'plan.md'), r.home, r.run)
    }
    // Reject automated approval before reading a plan or writing any file.
    if (command === 'approve' && (!r.inputTTY || !r.outputTTY)) throw new Refusal('approve requires both stdin and stdout to be terminals')
    if (command === 'approve') count(pos, 0, 0, 'approve')
    else if (command === 'dispatch' || command === 'stage') count(pos, 1, 1, `${command} <name>`)
    else if (command === 'gate') count(pos, 1, 2, 'gate <id> ["question"] [--no-wait]')
    else if (command === 'send') count(pos, 1, Infinity, 'send <role> <text…> (or text on stdin)')
    else if (command === 'close') count(pos, values.all ? 0 : 1, values.all ? 0 : 1, 'close <role> | --all')
    else if (command === 'teardown') count(pos, 0, 0, 'teardown [-m case] [--force]')
    else if (command === 'status') count(pos, 0, 0, 'status [--json] [--watch]')
    else if (command === 'wait') {
      count(pos, 0, 0, 'wait (--role <r> [--ready] | --gate <id>) [--timeout <s>]')
      if ((values.role === undefined) === (values.gate === undefined)) throw new Usage('wait requires exactly one of --role and --gate')
      if (values.ready && values.role === undefined) throw new Usage('--ready requires --role')
      if (values.timeout !== undefined && (values.timeout.trim() === '' || !Number.isFinite(Number(values.timeout)) || Number(values.timeout) < 0)) throw new Usage('--timeout must be a nonnegative number of seconds')
    }
    if (['dispatch', 'stage', 'gate', 'send'].includes(command) || (command === 'close' && !values.all)) id(pos[0], 'name')
    if (command === 'wait') id(values.role ?? values.gate, 'wait target')
    if (command === 'send' && pos.length === 1 && r.inputTTY) throw new Usage('send needs text arguments or text on stdin')
    if (command === 'status') return await status(r, want, !!values.json, !!values.watch)
    if (command === 'teardown' && want !== '') {
      // A torn-down case's worktree, and with it its plan, is gone: repeating teardown is a no-op.
      const repo = repository(r)
      if (finished(repo, want) && planOf(r, repo, want) === undefined) return { code: 0, out: `Nothing left to tear down for ${want}.\n` }
    }
    const m = caseOf(r, want)
    recordOrchestrator(r, m, m.name)
    if (command === 'audit') {
      if (pos.length === 0) throw new Usage('audit verify|report|show|outcome|calibrate')
      return await runAudit(r, m, { action: pos[0] ?? '', args: pos.slice(1), json: !!values.json, write: !!values.write, ...(values.note === undefined ? {} : { note: values.note }), planAudit: m.plan.audit })
    }
    if (command === 'teardown') {
      const config = auditConfig(r, m)
      audited(await recordTeardownAudit(m.common, m.name, teardownState(r, m), config), config, 'teardown')
      return await teardown(r, m, !!values.force)
    }
    if (command === 'approve') return await approve(r, m)
    if (command === 'dispatch') {
      const name = id(pos[0], 'role')
      const role = m.plan.roles.find(one => one.name === name)
      if (role !== undefined) {
        const config = auditConfig(r, m)
        audited(await recordRoleAudit(m.common, m.name, { name, agent: role.agent, touches: role.touches, goal: role.goal, text: role.section, dependsOn: role.dependsOn, planGoal: m.plan.goal }, config), config, `role ${name}`)
      }
      return await dispatch(r, m, name)
    }
    if (command === 'stage') return await stage(r, m, id(pos[0], 'stage'))
    if (command === 'gate') {
      const gate = id(pos[0], 'gate')
      const config = auditConfig(r, m)
      // A gate already asks the person, so enforce mode only refuses when the
      // decision is a block; medium asks the person through the gate itself.
      if (gate === PLAN_GATE) {
        const outcome = await recordPlanAudit(m.common, m.name, m.source, m.plan, config)
        if (blocksInEnforce(outcome, config.mode)) throw new Refusal(`plan gate: ${auditLine(outcome)}`)
      }
      else if (gate === 'mr-ok') {
        const view = statusOf(r, m)
        const results = view.roles.map(role => ({ role: role.name, status: role.state }))
        const reviews = view.roles.filter(role => role.summary !== '').map(role => `${role.name}: ${role.summary}`)
        const files = view.roles.reduce((sum, role) => sum + role.changed.length, 0)
        const commits = view.roles.reduce((sum, role) => sum + role.commits.length, 0)
        const outcome = await recordMergeAudit(m.common, m.name, { results, reviews, files, commits }, config)
        if (blocksInEnforce(outcome, config.mode)) throw new Refusal(`mr-ok gate: ${auditLine(outcome)}`)
      }
      append(m.log, 'cli', { ev: 'gate-open', gate, ...(pos[1] === undefined ? {} : { ask: pos[1] }), ...(gate === PLAN_GATE ? { plan: m.hash } : {}) })
      return values['no-wait'] ? { code: 0, out: `Opened gate ${gate}\n` } : await wait(r, m, { gate })
    }
    if (command === 'send') {
      const text = pos.length > 1 ? pos.slice(1).join(' ') : r.inputTTY ? '' : await r.input()
      if (text.trim() === '') throw new Usage('send needs text arguments or text on stdin')
      return await send(r, m, id(pos[0], 'role'), text)
    }
    if (command === 'close') return await close(r, m, values.all ? undefined : id(pos[0], 'role'))
    if (command === 'wait') return await wait(r, m, { ...(values.role === undefined ? { gate: id(values.gate, 'gate') } : { role: id(values.role, 'role'), ready: !!values.ready }), ...(values.timeout === undefined ? {} : { seconds: Number(values.timeout) }) })
    throw new Usage(`unknown command '${command}'`)
  } catch (error) {
    const usage = error instanceof Usage
    return { code: usage ? 2 : 1, out: `${paint(r, usage ? pc.yellow : pc.red, (error as Error).message)}\n` }
  }
}
