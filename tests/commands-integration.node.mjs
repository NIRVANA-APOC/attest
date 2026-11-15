import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { execute } from '../dist/commands.js'
import { runtime } from '../dist/command-context.js'
import { caseOf } from '../dist/cases.js'
import { append, readLog } from '../dist/log.js'
import { panelEffect } from '../dist/panel-actions.js'
import { readPanel } from '../dist/panel-model.js'
import { gateTarget } from '../dist/panel-input.js'
import { flushAnswers } from '../dist/orchestrator.js'
import { shellOf, tmux } from '../dist/run.js'
import { appendDecision, appendOutcome, ledgerPath } from '../dist/jev/ledger.js'
import { gitDirsOf } from '../dist/role-commands.js'

test('real scratch tmux: open marks one panel, keeps focus, and is a no-op the second time', { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'attest-open-integration-'))
  const socket = `attest-open-${process.pid}-${randomUUID().slice(0, 8)}`
  const env = { ...hostless(process.env), TMUX: undefined, TMUX_PANE: undefined, ATTEST_TMUX_SOCKET: socket }
  t.after(() => {
    tmux(['kill-server'], undefined, env)
    rmSync(root, { recursive: true, force: true })
  })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: root })
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim()
  const caller = tmux(['new-session', '-d', '-s', 'agent', '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', 'sleep 30'], undefined, env)
  assert.equal(caller.code, 0, caller.err)
  const pane = caller.out.trim()
  const r = runtime({ cwd: root, home: join(root, '.home'), env: { ...env, TMUX: 'scratch', TMUX_PANE: pane } })
  const first = await execute('open', ['--planning'], r)
  assert.equal(first.code, 0, first.out)
  const list = () => tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{@attest-panel}'], undefined, env).out.trim().split('\n')
  const panes = list()
  assert.equal(panes.length, 2)
  assert.equal(panes.filter(line => line.endsWith(`\t${repo}`)).length, 1)
  const panelPane = panes.find(line => line.endsWith(`\t${repo}`)).split('\t')[0]
  let firstFrame = ''
  for (let i = 0; i < 100; i++) {
    firstFrame = tmux(['capture-pane', '-p', '-t', panelPane], undefined, env).out.trim()
    if (firstFrame) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(firstFrame.includes('Orch is drafting the plan'), firstFrame)

  assert.equal(tmux(['display', '-p', '-t', 'agent', '#{pane_id}'], undefined, env).out.trim(), pane)
  const plain = await execute('open', [], r)
  assert.equal(plain.code, 1, plain.out)
  assert.match(plain.out, /no case for this pane; pass -m <case> \(no open case\)/)
  const second = await execute('open', ['--planning'], r)
  assert.equal(second.code, 0, second.out)
  assert.match(second.out, /already open/)
  assert.deepEqual(list(), panes)
  // Binding the pane later hands the planning panel its case.
  const made = await execute('case', ['new', 'later'], r)
  assert.equal(made.code, 0, made.out)
  assert.match(made.out, /already open/)
  assert.deepEqual(list(), panes)
  let frame = ''
  for (let i = 0; i < 200 && !frame.includes('later'); i++) {
    frame = tmux(['capture-pane', '-p', '-t', panelPane], undefined, env).out
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(frame.includes('later'), frame)
})

test('real scratch tmux: dispatch, live status, bracketed send, result wait and close', { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 20000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'attest-command-integration-'))
  const root = join(base, "repo with 'quotes'")
  const home = join(base, 'home')
  const socket = `attest-test-${process.pid}-${randomUUID().slice(0, 8)}`
  mkdirSync(root)
  mkdirSync(home)
  const env = { ...hostless(process.env), TMUX: undefined, TMUX_PANE: undefined, ATTEST_TMUX_SOCKET: socket }
  t.after(() => {
    tmux(['kill-server'], undefined, env)
    rmSync(base, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  const agent = join(root, 'fake-agent.sh')
  writeFileSync(agent, `#!/bin/sh
printf 'WORKING\\n'
sleep 1
printf '\\033[2J\\033[H\\033[?2004hREADY\\n'
while IFS= read -r line; do
  mkdir -p .attest
  printf '%s\\n' '---' 'status: done' 'summary: "fake agent received a line"' '---' 'Scratch result.' > .attest/result.md
  printf '\\033[2J\\033[HREADY\\n'
done
`)
  chmodSync(agent, 0o755)
  mkdirSync(join(root, '.attest/agents'), { recursive: true })
  writeFileSync(join(root, '.attest/agents/fake.yaml'), `command: ${JSON.stringify(agent)}
model: []
effort: []
permission:
  - [--policy]
prompt: last-arg
screen:
  waits: ['^WAIT$']
  working: ['^WORKING$']
  ready: ['^READY$']
paste: bracketed
`)
  mkdirSync(join(root, 'docs/cases/m1'), { recursive: true })
  writeFileSync(join(root, 'docs/cases/m1/plan.md'), '# Scratch\n\n```yaml\ngoal: Check commands\nbase: main\nroles:\n  api:\n    agent: fake\n    flags: [--policy, ask]\n    touches: []\n```\n\n## Role: api\n\nReply when sent a line.\n')
  git('add', '.')
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'initial')
  const r = runtime({ cwd: root, home, env, inputTTY: false, outputTTY: false })
  const m = caseOf(r, 'm1')
  append(m.log, 'panel', { ev: 'gate-answer', gate: 'plan', answer: 'approve', plan: m.hash })
  const session = `attest-${basename(root).replace(/[^A-Za-z0-9_-]/g, '-')}`
  const manual = tmux(['new-session', '-d', '-s', session, '-n', 'roles-m1', '-P', '-F', '#{pane_id}', 'sleep 30'], undefined, env)
  assert.equal(manual.code, 0, manual.err)
  const manualPane = manual.out.trim()
  const rolesWindow = tmux(['display', '-p', '-t', manualPane, '#{window_id}'], undefined, env).out.trim()
  const dispatched = await execute('dispatch', ['api', '-m', 'm1'], r)
  assert.equal(dispatched.code, 0, dispatched.out)
  const dispatch = readLog(m.log).events.find(e => e.ev === 'dispatch')
  const brief = join(dispatch.worktree, '.attest/brief.md')
  assert.equal(dispatch.argv.at(-1), `Read the brief in ${brief} and follow it.`)
  assert.equal(readFileSync(brief, 'utf8'), readFileSync(join(m.common, 'attest/m1/brief-api.md'), 'utf8'))
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dispatch.worktree, encoding: 'utf8' }).trim(), '')
  assert.equal(readLog(m.log).events.find(e => e.ev === 'dispatch').window, rolesWindow)
  const seen = new Set()
  for (let n = 0; n < 60; n++) {
    const status = await execute('status', ['--json', '-m', 'm1'], r)
    assert.equal(status.code, 0, status.out)
    const role = JSON.parse(status.out).roles[0]
    seen.add(role.state)
    if (role.state === 'idle') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(seen.has('working'), [...seen].join(', '))
  assert.ok(seen.has('idle'), [...seen].join(', '))
  const sent = await execute('send', ['api', 'Hello from the integration test', '-m', 'm1'], r)
  assert.equal(sent.code, 0, sent.out)
  const waited = await execute('wait', ['--role', 'api', '--timeout', '5', '-m', 'm1'], r)
  assert.equal(waited.code, 0, waited.out)
  assert.match(waited.out, /done: fake agent received a line/)
  const status = JSON.parse((await execute('status', ['--json', '-m', 'm1'], r)).out)
  assert.equal(status.roles[0].state, 'done')
  assert.deepEqual(status.roles[0].outside, [])
  const closed = await execute('close', ['api', '-m', 'm1'], r)
  assert.equal(closed.code, 0, closed.out)
  assert.ok(existsSync(status.roles[0].worktree))
  assert.equal(git('rev-parse', '--verify', 'role/m1/api').trim().length, 40)
  assert.deepEqual(readLog(m.log).events.map(e => e.ev), ['gate-answer', 'dispatch', 'send', 'close'])
  assert.match(readFileSync(join(status.roles[0].worktree, '.attest/result.md'), 'utf8'), /Scratch result/)
  assert.equal((await execute('dispatch', ['api', '-m', 'm1'], r)).code, 0)
  assert.equal((await execute('wait', ['--role', 'api', '--ready', '--timeout', '5', '-m', 'm1'], r)).code, 0)
  const reopened = readLog(m.log).events.filter(e => e.ev === 'dispatch').at(-1)
  for (const gate of ['mr-ok', 'merged']) append(m.log, 'panel', { ev: 'gate-answer', gate, answer: 'approve' })
  const torn = await execute('teardown', ['-m', 'm1'], r)
  assert.equal(torn.code, 0, torn.out)
  assert.notEqual(tmux(['display', '-p', '-t', reopened.pane, '#{pane_id}'], undefined, env).out.trim(), reopened.pane)
  assert.equal(existsSync(reopened.worktree), false)
  assert.equal(tmux(['display', '-p', '-t', manualPane, '#{pane_id}'], undefined, env).out.trim(), manualPane)
  assert.equal(readLog(m.log).events.at(-1).ev, 'teardown')
})

/** The test's own environment, without the agent session or terminal it may be running inside (#43 reads those). */
const hostless = env => ({ ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CLAUDE|CODEX|HERDR)_|^CLAUDECODE$/.test(key))), LANG: '', LC_ALL: '', LC_CTYPE: '' })
const cleanupRepo = t => {
  const root = mkdtempSync(join(tmpdir(), 'attest-teardown-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'case/m1')
  git('config', 'user.name', 'Probe')
  git('config', 'user.email', 'probe@example.invalid')
  mkdirSync(join(root, 'docs/cases/m1'), { recursive: true })
  writeFileSync(join(root, 'docs/cases/m1/plan.md'), '# Cleanup\n\n```yaml\ngoal: Cleanup\nbase: case/m1\nroles:\n  api:\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [src/]\n```\n\n## Role: api\n\nBuild it.\n')
  writeFileSync(join(root, 'tracked'), 'initial')
  git('add', '.')
  git('commit', '-qm', 'initial')
  const r = runtime({ cwd: root, home: join(root, 'home') })
  const m = caseOf(r, 'm1')
  append(m.log, 'orch', { ev: 'stage', stage: 'build' })
  // Teardown waits for every gate the workflow declares (#48); these cases have passed them.
  for (const gate of ['plan', 'mr-ok', 'merged']) append(m.log, 'panel', { ev: 'gate-answer', gate, answer: 'approve' })
  const path = join(root, '.attest/worktrees/m1/api')
  git('worktree', 'add', '-qb', 'role/m1/api', path)
  const call = (...args) => execute('teardown', ['-m', 'm1', ...args], r)
  const events = () => readLog(m.log).events
  return { root, git, r, m, path, call, events }
}

test('Codex Git grants stay within its index, shared objects and case refs', t => {
  const w = cleanupRepo(t)
  const role = { ...w.m.plan.roles[0], agent: 'codex', flags: ['-a', 'on-request', '-s', 'workspace-write'] }
  const dirs = gitDirsOf(w.r, w.m, role, w.path)
  assert.deepEqual(dirs, [
    w.git('-C', w.path, 'rev-parse', '--absolute-git-dir').trim(),
    join(w.m.common, 'objects'), join(w.m.common, 'refs/heads/role/m1'), join(w.m.common, 'logs/refs/heads/role/m1'),
  ])
  assert.ok(dirs.every(existsSync))
  assert.ok(!dirs.includes(w.m.common))
  assert.ok(!dirs.includes(join(w.m.common, 'refs/heads')))
  for (const flags of [['-s', 'read-only'], ['--sandbox=workspace-write', '-s', 'read-only'], ['-s=workspace-write', '--sandbox=read-only'], ['--sandbox=workspace-write', '-s=read-only'], ['-s', 'workspace-write', '--dangerously-bypass-approvals-and-sandbox']]) {
    assert.deepEqual(gitDirsOf(w.r, w.m, { ...role, flags }, w.path), [])
  }
  assert.deepEqual(gitDirsOf(w.r, w.m, { ...role, agent: 'claude' }, w.path), [])
  for (const flags of [['-s', 'workspace-write'], ['--sandbox', 'workspace-write'], ['-s=workspace-write'], ['--sandbox=workspace-write'], ['--sandbox=read-only', '-s=workspace-write']]) {
    assert.deepEqual(gitDirsOf(w.r, w.m, { ...role, flags }, w.path), dirs)
  }
})

test('teardown protects unmerged commits, tracked edits and untracked files; force preserves MR head and log', async t => {
  const w = cleanupRepo(t)
  const gitRole = (...args) => execFileSync('git', args, { cwd: w.path, encoding: 'utf8' })
  writeFileSync(join(w.path, 'committed'), 'valuable work')
  gitRole('add', '.')
  gitRole('commit', '-qm', 'unmerged')
  let reply = await w.call()
  assert.equal(reply.code, 1, reply.out)
  assert.match(reply.out, /role\/m1\/api: unmerged into case\/m1/)
  w.git('merge', '--ff-only', 'role/m1/api')
  writeFileSync(join(w.path, 'tracked'), 'dirty')
  writeFileSync(join(w.path, 'untracked'), 'valuable scratch')
  reply = await w.call()
  assert.equal(reply.code, 1, reply.out)
  assert.match(reply.out, /dirty or untracked/)
  gitRole('restore', 'tracked')
  assert.match((await w.call()).out, /dirty or untracked/, 'untracked files alone are protected')
  assert.ok(!w.events().some(e => e.ev === 'teardown'))
  const head = w.git('rev-parse', 'case/m1')
  writeFileSync(join(w.m.common, 'attest/m1/brief-api.md'), 'brief')
  writeFileSync(join(w.m.common, 'attest/m1/result-api-old.md'), 'moved result')
  reply = await w.call('--force')
  assert.equal(reply.code, 0, reply.out)
  assert.equal(w.git('rev-parse', 'case/m1'), head)
  assert.equal(existsSync(w.path), false)
  assert.equal(existsSync(join(w.root, '.attest/worktrees/m1')), false)
  assert.equal(w.git('branch', '--list', 'role/m1/*').trim(), '')
  assert.equal(existsSync(join(w.m.common, 'attest/m1/brief-api.md')), false)
  assert.equal(existsSync(join(w.m.common, 'attest/m1/result-api-old.md')), false)
  assert.equal(w.events().at(-1).ev, 'teardown')
  assert.match((await w.call()).out, /Nothing left/)
  assert.equal(w.events().filter(e => e.ev === 'teardown').length, 1)
  assert.equal((await execute('teardown', [], w.r)).code, 1, 'finished cases need explicit -m')
})

test('teardown takes a squash-merged role as merged by its content, and refuses a missing or later change (#49)', async t => {
  const w = cleanupRepo(t)
  const gitRole = (...args) => execFileSync('git', args, { cwd: w.path, encoding: 'utf8' })
  mkdirSync(join(w.path, 'src'), { recursive: true })
  writeFileSync(join(w.path, 'src/a'), 'a1')
  writeFileSync(join(w.path, 'src/b'), 'b1')
  gitRole('add', '.')
  gitRole('commit', '-qm', 'one')
  gitRole('mv', 'tracked', 'moved')
  gitRole('commit', '-qm', 'two')
  // Only part of the role reached the case branch.
  w.git('checkout', 'role/m1/api', '--', 'src/a')
  w.git('commit', '-qm', 'api: part')
  let reply = await w.call()
  assert.equal(reply.code, 1, reply.out)
  assert.match(reply.out, /role\/m1\/api: unmerged into case\/m1 \(its changes differ from the target\)/)
  // The whole role as one commit, a rename included: merged, though not an ancestor.
  w.git('rm', '-q', 'tracked')
  w.git('checkout', 'role/m1/api', '--', 'src', 'moved')
  w.git('commit', '-qm', 'api: all')
  assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', 'role/m1/api', 'case/m1'], { cwd: w.root }).status, 0)
  // A commit on the role branch after the squash is missing again.
  writeFileSync(join(w.path, 'src/a'), 'a2')
  gitRole('commit', '-qam', 'three')
  reply = await w.call()
  assert.equal(reply.code, 1, reply.out)
  assert.match(reply.out, /unmerged into case\/m1/)
  w.git('checkout', 'role/m1/api', '--', 'src/a')
  w.git('commit', '-qm', 'api: three')
  reply = await w.call()
  assert.equal(reply.code, 0, reply.out)
  assert.equal(w.git('branch', '--list', 'role/m1/*').trim(), '')
  assert.equal(existsSync(w.path), false)
})

test('teardown waits for every gate the workflow declares, the merged gate included; --force overrides (#48)', async t => {
  const w = cleanupRepo(t)
  append(w.m.log, 'panel', { ev: 'gate-open', gate: 'merged', ask: 'https://example.invalid/pr/1' })
  let reply = await w.call()
  assert.equal(reply.code, 1, reply.out)
  assert.match(reply.out, /gate merged: not approved yet; teardown waits for it/)
  assert.doesNotMatch(reply.out, /gate (plan|mr-ok)/)
  assert.ok(existsSync(w.path), 'the role window and worktree stay for a requested change')
  append(w.m.log, 'panel', { ev: 'gate-answer', gate: 'merged', answer: 'change', text: 'rename the flag' })
  assert.match((await w.call()).out, /gate merged: not approved yet/)
  reply = await w.call('--force')
  assert.equal(reply.code, 0, reply.out)
})

test('clean teardown works without force and partial failure stays open for a retry', async t => {
  const w = cleanupRepo(t)
  const failed = await execute('teardown', ['-m', 'm1'], { ...w.r, run: (command, args, options) => command === 'git' && args[0] === 'branch' && args[1] === '-D'
    ? { code: 1, out: '', err: 'simulated branch deletion failure' } : w.r.run(command, args, options) })
  assert.equal(failed.code, 1)
  assert.match(failed.out, /simulated branch deletion failure/)
  assert.equal(existsSync(w.path), false)
  assert.ok(!w.events().some(e => e.ev === 'teardown'))
  assert.equal(caseOf(w.r).name, 'm1', 'partial cleanup remains selected')
  const reply = await w.call()
  assert.equal(reply.code, 0, reply.out)
  assert.match((await w.call()).out, /Nothing left/)
})

test('a commit made while panes close is retained and does not finish teardown', async t => {
  const w = cleanupRepo(t)
  let committed = false
  const reply = await execute('teardown', ['-m', 'm1'], { ...w.r, run: (command, args, options) => {
    if (!committed && command === 'git' && args[0] === 'merge-base') {
      const result = w.r.run(command, args, options)
      writeFileSync(join(w.path, 'late'), 'late commit')
      execFileSync('git', ['add', 'late'], { cwd: w.path })
      execFileSync('git', ['commit', '-qm', 'late'], { cwd: w.path })
      committed = true
      return result
    }
    return w.r.run(command, args, options)
  } })
  assert.equal(reply.code, 1, reply.out)
  assert.match(reply.out, /unmerged into case\/m1/)
  assert.ok(existsSync(w.path))
  assert.ok(!w.events().some(e => e.ev === 'teardown'))
  assert.match(w.git('log', '-1', '--format=%s', 'role/m1/api'), /late/)
})


test('real scratch tmux: a panel answer reaches the marked ready agent once', { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 15000 }, async t => {
  const w = cleanupRepo(t)
  const socket = `attest-wake-${process.pid}-${randomUUID().slice(0, 8)}`
  const env = { ...hostless(process.env), TMUX: undefined, TMUX_PANE: undefined, ATTEST_TMUX_SOCKET: socket }
  t.after(() => tmux(['kill-server'], undefined, env))
  const received = join(w.root, '.attest/received.txt')
  const script = `printf '› Ask Codex to do anything\\n'; while IFS= read -r line; do printf '%s\\n' "$line" >> ${shellOf([received])}; done`
  const caller = tmux(['new-session', '-d', '-s', 'agent', '-P', '-F', '#{pane_id}', shellOf(['/bin/sh', '-c', script])], undefined, env)
  assert.equal(caller.code, 0, caller.err)
  const pane = caller.out.trim()
  const r = runtime({ ...w.r, env: { ...env, TMUX: 'scratch', TMUX_PANE: pane } })
  assert.equal((await execute('open', [], r)).code, 0)
  append(w.m.log, 'orch', { ev: 'gate-open', gate: 'plan', plan: w.m.hash })
  const reading = readPanel(r, 'm1')
  assert.ok('model' in reading)
  assert.equal(await panelEffect(r, 'm1', { kind: 'answer', gate: gateTarget(reading.model), answer: 'approve' }), 'Approved plan')
  for (let i = 0; i < 50 && !existsSync(received); i++) {
    flushAnswers(r, caseOf(r, 'm1'))
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(readFileSync(received, 'utf8'), 'plan approved in the panel. Continue the case.\n')
  flushAnswers(r, caseOf(r, 'm1'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(readFileSync(received, 'utf8').trim().split('\n').length, 1)
})

// Two orchestrators, each bound to its own case, plus an unbound pane, on one scratch tmux server.
const parallelWorld = (t, prefix) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `attest-${prefix}-`)))
  const socket = `attest-${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`
  const env = { ...hostless(process.env), TMUX: undefined, TMUX_PANE: undefined, ATTEST_TMUX_SOCKET: socket }
  t.after(() => {
    tmux(['kill-server'], undefined, env)
    rmSync(base, { recursive: true, force: true })
  })
  const home = join(base, 'home')
  mkdirSync(home)
  const agent = join(base, 'fake-agent.sh')
  writeFileSync(agent, "#!/bin/sh\nprintf '\\033[2J\\033[HREADY\\n'\nwhile IFS= read -r line; do printf '\\033[2J\\033[HREADY\\n'; done\n")
  chmodSync(agent, 0o755)
  const repo = name => {
    const root = join(base, name)
    mkdirSync(join(root, '.attest/agents'), { recursive: true })
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Probe')
    git('config', 'user.email', 'probe@example.invalid')
    writeFileSync(join(root, '.attest/agents/fake.yaml'), `command: ${JSON.stringify(agent)}\nmodel: []\neffort: []\npermission:\n  - [--policy]\nprompt: last-arg\nscreen:\n  waits: ['^WAIT$']\n  working: ['^WORKING$']\n  ready: ['^READY$']\npaste: bracketed\n`)
    writeFileSync(join(root, 'README'), name)
    git('add', '.')
    git('commit', '-qm', 'initial')
    return { root, git }
  }
  // An orchestrator stand-in: a Codex-like prompt that records every line typed into it.
  const orchestrator = (name, window) => {
    const received = join(base, `${name}.received`)
    const script = `printf '› Ask Codex to do anything\\n'; while IFS= read -r line; do printf '%s\\n' "$line" >> ${shellOf([received])}; done`
    const opened = tmux(window === 0 ? ['new-session', '-d', '-s', 'agents', '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', shellOf(['/bin/sh', '-c', script])]
      : ['new-window', '-d', '-t', 'agents:', '-P', '-F', '#{pane_id}', shellOf(['/bin/sh', '-c', script])], undefined, env)
    assert.equal(opened.code, 0, opened.err)
    return { pane: opened.out.trim(), received }
  }
  const at = (cwd, pane) => runtime({ cwd, home, env: { ...env, TMUX: 'scratch', TMUX_PANE: pane }, inputTTY: false, outputTTY: false })
  const panes = () => tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{@attest-panel}\t#{@attest-panel-orchestrator}\t#{@attest-case}\t#{@attest-case-repo}'], undefined, env).out.trim().split('\n')
    .map(line => { const [pane, panel, orchestrator, caseName, repo] = line.split('\t'); return { pane, panel, orchestrator, case: caseName, repo } })
  const windows = () => tmux(['list-windows', '-a', '-F', '#{window_name}\t#{window_panes}'], undefined, env).out.trim().split('\n')
  return { base, env, repo, orchestrator, at, panes, windows }
}

const fakePlan = name => `# ${name}\n\n\`\`\`yaml\ngoal: Check ${name}\nbase: case/${name}\nroles:\n  api:\n    agent: fake\n    flags: [--policy, ask]\n    touches: []\n\`\`\`\n\n## Role: api\n\nReply.\n`

test('real scratch tmux: two cases in one repository each follow their own orchestrator pane', { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 40000 }, async t => {
  const w = parallelWorld(t, 'parallel')
  const { root, git } = w.repo('repo')
  const a = w.orchestrator('a', 0)
  const b = w.orchestrator('b', 1)
  const c = w.orchestrator('c', 2)
  const [ra, rb, rc] = [a, b, c].map(one => w.at(root, one.pane))

  for (const [name, r] of [['alpha', ra], ['beta', rb]]) {
    const made = await execute('case', ['new', name], r)
    assert.equal(made.code, 0, made.out)
    assert.ok(made.out.includes(join(root, '.attest/cases', name)), made.out)
    assert.equal(git('symbolic-ref', '--short', 'HEAD').trim(), 'main', 'case new never switches the main checkout')
  }
  assert.match((await execute('case', ['new', 'beta'], rc)).out, /already exists/)
  assert.match((await execute('case', ['new', 'gamma'], ra)).out, /runs case alpha/)
  assert.equal(git('status', '--porcelain').trim(), '', 'case worktrees stay out of the main checkout status')

  // Each caller pane resolves its own case without -m, from the main checkout.
  for (const [name, r] of [['alpha', ra], ['beta', rb]]) {
    const worktree = join(root, '.attest/cases', name)
    writeFileSync(join(worktree, `docs/cases/${name}/plan.md`), fakePlan(name))
    execFileSync('git', ['add', '.'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', `${name}: plan`], { cwd: worktree })
    const m = caseOf(r)
    assert.equal(m.name, name)
    assert.equal(m.worktree, worktree)
    const checked = await execute('check', [], r)
    assert.equal(checked.code, 0, checked.out)
    append(m.log, 'panel', { ev: 'gate-answer', gate: 'plan', answer: 'approve', plan: m.hash })
    assert.equal(JSON.parse((await execute('status', ['--json'], r)).out).case, name)
  }
  // -m reads the other case's plan from wherever it runs, but not against a pane's own binding.
  assert.equal(caseOf(rc, 'beta').worktree, join(root, '.attest/cases/beta'))
  assert.match((await execute('status', ['-m', 'beta'], ra)).out, /runs case alpha; -m beta names another/)

  // An unbound pane refuses and lists both; status lists them with exit 0.
  const refused = await execute('stage', ['build'], rc)
  assert.equal(refused.code, 1)
  for (const name of ['alpha', 'beta']) assert.ok(refused.out.includes(`${name}  ${join(root, '.attest/cases', name)}`), refused.out)
  const listed = await execute('status', ['--json'], rc)
  assert.equal(listed.code, 0, listed.out)
  const open = JSON.parse(listed.out).cases
  assert.deepEqual(open.map(one => [one.name, one.orchestrator]), [['alpha', a.pane], ['beta', b.pane]])

  // One panel per case, beside its orchestrator, and open stays idempotent per case.
  const panels = () => w.panes().filter(one => one.panel === root)
  assert.deepEqual(panels().map(one => [one.orchestrator, one.case]).sort(), [[a.pane, 'alpha'], [b.pane, 'beta']])
  assert.deepEqual(open.map(one => one.panel), [panels().find(one => one.case === 'alpha').pane, panels().find(one => one.case === 'beta').pane])
  assert.match((await execute('open', [], ra)).out, /already open/)
  assert.equal(panels().length, 2)
  // An unbound pane neither opens an idle panel nor takes over a live orchestrator's case.
  const idle = await execute('open', [], rc)
  assert.equal(idle.code, 1)
  for (const name of ['alpha', 'beta']) assert.ok(idle.out.includes(`${name}  ${join(root, '.attest/cases', name)}`), idle.out)
  const unbound = readPanel(rc, '')
  assert.ok(unbound.missing.startsWith('panel: no case for this pane') && unbound.missing.includes('alpha') && unbound.missing.includes('beta'), unbound.missing)
  const stolen = await execute('open', ['-m', 'alpha'], rc)
  assert.equal(stolen.code, 1)
  assert.match(stolen.out, new RegExp(`case alpha is run by pane ${a.pane}`))
  assert.ok(!w.panes().find(one => one.pane === c.pane).case, 'the unbound pane stays unbound')
  assert.equal(panels().length, 2)
  const alphaPanel = panels().find(one => one.case === 'alpha').pane
  let frame = ''
  for (let i = 0; i < 150 && !frame.includes('alpha'); i++) {
    frame = tmux(['capture-pane', '-p', '-t', alphaPanel], undefined, w.env).out
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(frame.includes('alpha') && !frame.includes('beta'), frame)

  // One roles-<m> window per case.
  for (const r of [ra, rb]) {
    const dispatched = await execute('dispatch', ['api'], r)
    assert.equal(dispatched.code, 0, dispatched.out)
  }
  assert.deepEqual(w.windows().filter(line => line.startsWith('roles')).sort(), ['roles-alpha\t1', 'roles-beta\t1'])
  assert.ok(existsSync(join(root, '.attest/worktrees/alpha/api')) && existsSync(join(root, '.attest/worktrees/beta/api')), 'role worktrees stay under the main checkout')

  // A gate answer reaches only its own case's orchestrator.
  assert.equal((await execute('gate', ['release', 'Ship alpha?', '--no-wait'], ra)).code, 0)
  const rPanel = w.at(root, alphaPanel)
  const reading = readPanel(rPanel, '')
  assert.equal(reading.case.name, 'alpha', 'the panel resolves through its orchestrator')
  assert.equal(await panelEffect(rPanel, 'alpha', { kind: 'answer', gate: gateTarget(reading.model), answer: 'approve' }), 'Approved release')
  for (let i = 0; i < 100 && !existsSync(a.received); i++) {
    flushAnswers(rPanel, caseOf(rPanel))
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(readFileSync(a.received, 'utf8'), 'release approved in the panel. Continue the case.\n')
  assert.equal(existsSync(b.received), false)

  // Teardown of beta waits for its push, then leaves alpha intact.
  const beta = join(root, '.attest/cases/beta')
  for (const gate of ['plan', 'mr-ok', 'merged']) append(caseOf(rb).log, 'panel', { ev: 'gate-answer', gate, answer: 'approve' })
  assert.match((await execute('teardown', [], rb)).out, /case\/beta: not pushed/)
  execFileSync('git', ['init', '-q', '--bare', join(w.base, 'remote.git')])
  git('remote', 'add', 'origin', join(w.base, 'remote.git'))
  execFileSync('git', ['push', '-q', 'origin', 'case/beta'], { cwd: beta, stdio: 'ignore' })
  const torn = await execute('teardown', [], rb)
  assert.equal(torn.code, 0, torn.out)
  assert.equal(existsSync(beta), false)
  assert.equal(git('rev-parse', '--verify', '-q', 'case/beta').trim().length, 40, 'the case branch stays')
  assert.deepEqual(panels().map(one => one.case), ['alpha'])
  assert.equal(w.panes().find(one => one.pane === b.pane).case, '', 'the beta orchestrator is unbound')
  assert.deepEqual(w.windows().filter(line => line.startsWith('roles')), ['roles-alpha\t1'])
  assert.ok(existsSync(join(root, '.attest/cases/alpha')))
  assert.equal(JSON.parse((await execute('status', ['--json'], ra)).out).roles[0].state !== 'gone', true)
  assert.match((await execute('teardown', ['-m', 'beta'], rc)).out, /Nothing left to tear down for beta/)
  assert.deepEqual(JSON.parse((await execute('status', ['--json'], rc)).out).cases.map(one => one.name), ['alpha'])

  // Once alpha's orchestrator is gone, another pane may take the case and its panel over.
  assert.equal(tmux(['kill-pane', '-t', a.pane], undefined, w.env).code, 0)
  const taken = await execute('open', ['-m', 'alpha'], rc)
  assert.equal(taken.code, 0, taken.out)
  assert.match(taken.out, /already open/)
  assert.equal(w.panes().find(one => one.pane === c.pane).case, 'alpha')
  assert.deepEqual(panels().map(one => [one.orchestrator, one.case]), [[c.pane, 'alpha']])
})

test('real scratch tmux: the same case name in two repositories stays apart', { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 20000 }, async t => {
  const w = parallelWorld(t, 'repos')
  const one = w.repo('one')
  const two = w.repo('two')
  const a = w.orchestrator('a', 0)
  const b = w.orchestrator('b', 1)
  assert.equal((await execute('case', ['new', 'alpha'], w.at(one.root, a.pane))).code, 0)
  assert.equal((await execute('case', ['new', 'alpha'], w.at(two.root, b.pane))).code, 0)
  assert.equal(caseOf(w.at(one.root, a.pane)).worktree, join(one.root, '.attest/cases/alpha'))
  assert.equal(caseOf(w.at(two.root, b.pane)).worktree, join(two.root, '.attest/cases/alpha'))
  // A pane bound to an open case in one repository cannot start another in a second one.
  const twice = await execute('case', ['new', 'beta'], w.at(two.root, a.pane))
  assert.equal(twice.code, 1)
  assert.match(twice.out, new RegExp(`this pane runs case alpha in ${one.root}; start beta from another pane`))
  assert.equal(existsSync(join(two.root, '.attest/cases/beta')), false)
  assert.equal(w.panes().find(p => p.pane === a.pane).repo.startsWith(one.root), true)
  // Nor can it take over a case in the second one whose orchestrator is gone.
  const q = w.orchestrator('q', 2)
  assert.equal((await execute('case', ['new', 'beta'], w.at(two.root, q.pane))).code, 0)
  assert.equal(tmux(['kill-pane', '-t', q.pane], undefined, w.env).code, 0)
  const takeover = await execute('open', ['-m', 'beta'], w.at(two.root, a.pane))
  assert.equal(takeover.code, 1)
  assert.match(takeover.out, new RegExp(`this pane runs case alpha in ${one.root}; open beta from another pane`))
  const held = w.panes().find(p => p.pane === a.pane)
  assert.equal(held.case, 'alpha')
  assert.equal(held.repo.startsWith(one.root), true)
  // A pane bound in one repository is unbound in the other.
  const across = JSON.parse((await execute('status', ['--json'], w.at(two.root, a.pane))).out)
  assert.deepEqual(across.cases.map(m => [m.name, m.orchestrator]), [['alpha', b.pane], ['beta', '']])
  const panels = w.panes().filter(p => p.panel !== '' && p.orchestrator !== q.pane)
  assert.deepEqual(panels.map(p => [p.panel, p.orchestrator]).sort(), [[one.root, a.pane], [two.root, b.pane]])
})

// Independent end-to-end verification (qa/task-6): one case driven only through
// the public command surface with a fake adapter in a temp repo. It exercises
// case new, check, gate/approval, dispatch, wait, status, send, close and
// teardown, and asserts the git worktrees/branches and every exit code.
test('end-to-end fake agents: case new → check → approve → dispatch → wait → status → send → close → teardown', { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 60000 }, async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'attest-e2e-')))
  const root = join(base, 'repo')
  const home = join(base, 'home')
  mkdirSync(root)
  mkdirSync(home)
  const socket = `attest-e2e-${process.pid}-${randomUUID().slice(0, 8)}`
  const env = { ...hostless(process.env), TMUX: undefined, TMUX_PANE: undefined, ATTEST_TMUX_SOCKET: socket }
  t.after(() => {
    tmux(['kill-server'], undefined, env)
    rmSync(base, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Probe')
  git('config', 'user.email', 'probe@example.invalid')
  const agent = join(base, 'fake-agent.sh')
  // The adapter writes .attest/result.md as soon as it starts, then stays ready
  // for a line, writing a second result; this is the documented adapter contract.
  writeFileSync(agent, `#!/bin/sh
printf '\\033[2J\\033[HREADY\\n'
mkdir -p .attest
printf '%s\\n' '---' 'status: done' 'summary: "fake agent completed the task"' '---' 'E2E result evidence.' > .attest/result.md
while IFS= read -r line; do
  printf '%s\\n' '---' 'status: done' 'summary: "fake agent received a line"' '---' "$line" > .attest/result.md
  printf '\\033[2J\\033[HREADY\\n'
done
`)
  chmodSync(agent, 0o755)
  mkdirSync(join(root, '.attest/agents'), { recursive: true })
  writeFileSync(join(root, '.attest/agents/fake.yaml'), `command: ${JSON.stringify(agent)}
model: []
effort: []
permission:
  - [--policy]
prompt: last-arg
screen:
  waits: ['^WAIT$']
  working: ['^WORKING$']
  ready: ['^READY$']
paste: bracketed
`)
  writeFileSync(join(root, 'README'), 'e2e\n')
  git('add', '.')
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'initial')
  const r = runtime({ cwd: root, home, env, inputTTY: false, outputTTY: false })

  // case new: worktree on case/<name>, plan in the worktree, new case bound to the pane.
  const made = await execute('case', ['new', 'e2e'], r)
  assert.equal(made.code, 0, made.out)
  assert.match(made.out, /Case e2e: .*\.attest\/cases\/e2e on case\/e2e/)
  assert.equal(git('rev-parse', '--verify', 'case/e2e').trim().length, 40)
  assert.equal(git('symbolic-ref', '--short', 'HEAD').trim(), 'main', 'case new never switches the main checkout')
  const caseWorktree = join(root, '.attest/cases/e2e')
  assert.ok(existsSync(join(caseWorktree, 'docs/cases/e2e/plan.md')))
  const twice = await execute('case', ['new', 'e2e'], r)
  assert.equal(twice.code, 1, twice.out)
  assert.match(twice.out, /already exists/, 'a taken case branch is refused, not silently reused')

  // a real plan, committed on the case branch and pushed to a bare origin so a
  // safe (non-force) teardown can prove the case branch is safe to remove.
  writeFileSync(join(caseWorktree, 'docs/cases/e2e/plan.md'), `# E2E
\`\`\`yaml
goal: "E2E: a fake agent completes a case"
base: case/e2e
roles:
  api:
    agent: fake
    flags: [--policy, ask]
    touches: []
\`\`\`

## Role: api

Complete the fake work.
`)
  gitIn(caseWorktree, 'add', 'docs/cases/e2e/plan.md')
  gitIn(caseWorktree, 'commit', '-qm', 'e2e: plan')
  git('init', '-q', '--bare', join(base, 'origin.git'))
  git('remote', 'add', 'origin', join(base, 'origin.git'))
  git('push', '-q', '-u', 'origin', 'case/e2e')

  // check: the plan is clean; a missing case is a usage-class refusal (exit 2).
  const checked = await execute('check', ['-m', 'e2e'], r)
  assert.equal(checked.code, 0, checked.out)
  assert.match(checked.out, /docs\/cases\/e2e\/plan\.md: clean \(1 role: api\)/)
  const missing = await execute('check', ['-m', 'nope'], r)
  assert.equal(missing.code, 2, missing.out)
  assert.match(missing.out, /attest check: no plan at docs\/cases\/nope\/plan\.md/)

  // approve is terminal-only; the gate flow is the documented substitute for tests.
  const refusedApprove = await execute('approve', [], r)
  assert.equal(refusedApprove.code, 1, refusedApprove.out)
  assert.match(refusedApprove.out, /approve requires both stdin and stdout to be terminals/)
  const opened = await execute('gate', ['plan', 'E2E plan ready', '--no-wait', '-m', 'e2e'], r)
  assert.equal(opened.code, 0, opened.out)
  assert.match(opened.out, /Opened gate plan/)
  const m = caseOf(r, 'e2e')
  append(m.log, 'panel', { ev: 'gate-answer', gate: 'plan', answer: 'approve', plan: m.hash })
  const answered = await execute('wait', ['--gate', 'plan', '--timeout', '5', '-m', 'e2e'], r)
  assert.equal(answered.code, 0, answered.out)
  assert.match(answered.out, /^approve/m)
  const sendBeforeDispatch = await execute('send', ['api', 'hello', '-m', 'e2e'], r)
  assert.equal(sendBeforeDispatch.code, 1, sendBeforeDispatch.out)
  assert.match(sendBeforeDispatch.out, /role api: no open pane recorded by attest/)
  const unknownRole = await execute('dispatch', ['bogus', '-m', 'e2e'], r)
  assert.equal(unknownRole.code, 1, unknownRole.out)
  assert.match(unknownRole.out, /unknown role: bogus/)

  // dispatch: one worktree and role branch per role, clean tree, brief in both places.
  const dispatched = await execute('dispatch', ['api', '-m', 'e2e'], r)
  assert.equal(dispatched.code, 0, dispatched.out)
  assert.match(dispatched.out, /Dispatched api to %\d+; .*\.attest\/worktrees\/e2e\/api on role\/e2e\/api/)
  const dispatch = readLog(m.log).events.find(e => e.ev === 'dispatch')
  assert.equal(dispatch.role, 'api')
  assert.equal(dispatch.branch, 'role/e2e/api')
  assert.equal(dispatch.worktree, join(root, '.attest/worktrees/e2e/api'))
  assert.equal(dispatch.base, git('rev-parse', 'case/e2e').trim())
  assert.equal(git('rev-parse', '--verify', 'role/e2e/api').trim().length, 40)
  assert.equal(existsSync(join(dispatch.worktree, '.attest/brief.md')), true)
  assert.equal(readFileSync(join(dispatch.worktree, '.attest/brief.md'), 'utf8'), readFileSync(join(m.common, 'attest/e2e/brief-api.md'), 'utf8'))
  assert.match(readFileSync(join(dispatch.worktree, '.attest/brief.md'), 'utf8'), /Complete the fake work\./)
  assert.equal(gitIn(dispatch.worktree, 'status', '--porcelain', '--untracked-files=all').trim(), '')

  // wait for the result the adapter wrote at startup (tolerate the write race).
  let waited
  for (let n = 0; n < 100; n++) {
    waited = await execute('wait', ['--role', 'api', '--timeout', '1', '-m', 'e2e'], r)
    if (waited.code === 0) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(waited.code, 0, waited.out)
  assert.match(waited.out, /done: fake agent completed the task/)
  const ready = await execute('wait', ['--role', 'api', '--ready', '--timeout', '5', '-m', 'e2e'], r)
  assert.equal(ready.code, 0, ready.out)
  assert.match(ready.out, /api: ready/)

  // status --json: the role reports its branch, result summary and no outside changes.
  const status = JSON.parse((await execute('status', ['--json', '-m', 'e2e'], r)).out)
  assert.equal(status.case, 'e2e')
  assert.equal(status.roles.length, 1)
  assert.equal(status.roles[0].state, 'done')
  assert.equal(status.roles[0].branch, 'role/e2e/api')
  assert.equal(status.roles[0].summary, 'fake agent completed the task')
  assert.deepEqual(status.roles[0].outside, [])
  assert.deepEqual(status.roles[0].changed, [])

  // send types into the ready pane; the next result reports the line and is moved to the log side.
  const sent = await execute('send', ['api', 'turn two', '-m', 'e2e'], r)
  assert.equal(sent.code, 0, sent.out)
  let second
  for (let n = 0; n < 100; n++) {
    second = await execute('wait', ['--role', 'api', '--timeout', '1', '-m', 'e2e'], r)
    if (second.code === 0 && /received a line/.test(second.out)) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(second.code, 0, second.out)
  assert.match(second.out, /done: fake agent received a line/)
  assert.match(readFileSync(join(dispatch.worktree, '.attest/result.md'), 'utf8'), /turn two/)
  assert.equal(readLog(m.log).events.filter(e => e.ev === 'send').length, 1)

  // close keeps the worktree and branch for the review/merge stage.
  const closed = await execute('close', ['api', '-m', 'e2e'], r)
  assert.equal(closed.code, 0, closed.out)
  assert.ok(existsSync(dispatch.worktree))
  assert.equal(git('rev-parse', '--verify', 'role/e2e/api').trim().length, 40)

  // teardown refuses while the workflow gates are unanswered and keeps everything.
  const sweptEarly = await execute('teardown', ['-m', 'e2e'], r)
  assert.equal(sweptEarly.code, 1, sweptEarly.out)
  assert.match(sweptEarly.out, /gate mr-ok: not approved yet/)
  assert.ok(existsSync(dispatch.worktree))
  assert.ok(existsSync(caseWorktree))
  for (const gate of ['mr-ok', 'merged']) append(m.log, 'panel', { ev: 'gate-answer', gate, answer: 'approve' })

  // teardown: the role worktree/branch go, the pushed case branch is kept.
  const torn = await execute('teardown', ['-m', 'e2e'], r)
  assert.equal(torn.code, 0, torn.out)
  assert.match(torn.out, /Tore down e2e; kept case branch case\/e2e/)
  assert.equal(existsSync(dispatch.worktree), false)
  assert.equal(existsSync(caseWorktree), false)
  assert.equal(git('branch', '--list', 'role/e2e/*').trim(), '')
  assert.equal(git('branch', '--list', 'case/e2e').trim(), 'case/e2e')
  assert.equal(readLog(m.log).events.at(-1).ev, 'teardown')
  assert.match((await execute('send', ['api', 'after teardown', '-m', 'e2e'], r)).out, /no plan for case e2e|role api: no open pane recorded/)
})

// ---- `attest audit` (qa/task-6): the Jev ledger commands end to end. Records
// are written through the real ledger module, then read back through the CLI
// surface the lead wires; a middle record is edited to prove verify refuses it
// with the record number.
const auditDecision = (id, second, probability, band, action, reason) => ({
  id,
  at: `2026-11-15T12:0${second}:00.000Z`,
  provider: 'heuristic',
  stateDigest: `sha256:${String(second).padStart(2, '0').repeat(32)}`,
  answers: { risk: { kind: 'noul', probability } },
  band,
  action,
  reason,
  latencyMs: 2,
  reasonCode: 'policy.shadow',
})

const auditWorld = t => {
  const base = mkdtempSync(join(tmpdir(), 'attest-audit-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  const home = join(base, 'home')
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  mkdirSync(join(root, 'docs/cases/audit'), { recursive: true })
  mkdirSync(join(root, '.attest/agents'), { recursive: true })
  mkdirSync(home)
  writeFileSync(join(root, '.attest/agents/fake.yaml'), 'command: fake\nmodel: []\neffort: []\npermission:\n  - [--policy]\nprompt: last-arg\n')
  writeFileSync(join(root, 'docs/cases/audit/plan.md'), `# Audit case
\`\`\`yaml
goal: "Audit CLI verification"
base: main
audit:
  mode: shadow
  provider: heuristic
roles:
  api:
    agent: fake
    flags: [--policy, ask]
    touches: []
\`\`\`

## Role: api

Do nothing.
`)
  gitIn(root, 'init', '-q', '-b', 'main')
  gitIn(root, 'config', 'user.name', 'Probe')
  gitIn(root, 'config', 'user.email', 'probe@example.invalid')
  gitIn(root, 'add', '.')
  gitIn(root, 'commit', '-qm', 'initial')
  const r = runtime({ cwd: root, home })
  const m = caseOf(r, 'audit')
  return { base, root, home, r, m, ledger: ledgerPath(m.common, 'audit') }
}

test('audit CLI: verify/report/show/outcome/calibrate over a real ledger, JSON shapes, exit codes and a tampered record', { timeout: 30000 }, async t => {
  const w = auditWorld(t)
  appendDecision(w.ledger, auditDecision('plan.risk', 1, 0.82, 'high', 'shadow', 'the plan runs a destructive command'))
  appendDecision(w.ledger, auditDecision('merge.risk', 2, 0.10, 'low', 'shadow', 'changes stay inside the touches'))
  const run = (...args) => execute('audit', [...args, '-m', 'audit'], w.r)

  // verify: exit 0, the count, and the audit-verify record it appends.
  const verified = await run('verify')
  assert.equal(verified.code, 0, verified.out)
  assert.match(verified.out, /OK 2 records/)
  assert.match(verified.out, /Verify record 2 appended/)
  const verifiedJson = JSON.parse((await run('verify', '--json')).out)
  assert.equal(verifiedJson.ok, true)
  assert.equal(verifiedJson.length, 3, 'a verify appends its own record')
  assert.equal(verifiedJson.appended, 3)
  assert.equal(verifiedJson.brokenAt, undefined)

  // report: JSON shape, text and --write into the case worktree.
  const report = JSON.parse((await run('report', '--json')).out)
  assert.equal(report.case, 'audit')
  assert.equal(report.chain.ok, true)
  assert.equal(report.mode, 'shadow')
  assert.equal(report.provider, 'heuristic')
  assert.deepEqual(report.counts, { allow: 0, ask: 0, block: 0, shadow: 2 })
  assert.deepEqual(report.bands, { low: 1, medium: 0, high: 1, unknown: 0 })
  assert.equal(report.risk, 'high')
  assert.equal(report.decisions.length, 2)
  assert.equal(report.decisions[0].id, 'plan.risk')
  assert.equal(report.decisions[0].probability, 0.82)
  const reportText = await run('report')
  assert.equal(reportText.code, 0, reportText.out)
  assert.match(reportText.out, /# Audit: audit/)
  assert.match(reportText.out, /- Chain: OK 4 records/)
  const wrote = await run('report', '--write')
  assert.equal(wrote.code, 0, wrote.out)
  const auditMd = join(w.root, 'docs/cases/audit/audit.md')
  assert.equal(existsSync(auditMd), true)
  assert.match(readFileSync(auditMd, 'utf8'), /# Audit: audit/)
  assert.match(wrote.out, /Wrote .*docs\/cases\/audit\/audit\.md/)

  // show: by sequence number and by decision id; a miss is a refusal.
  const shown = await run('show', '0')
  assert.equal(shown.code, 0, shown.out)
  assert.match(shown.out, /seq 0 · plan\.risk · 2026-11-15T12:01:00\.000Z/)
  assert.match(shown.out, /band high · action shadow · provider heuristic/)
  assert.match(shown.out, new RegExp(`state sha256:${'01'.repeat(32)}`))
  assert.match(shown.out, /reason the plan runs a destructive command/)
  assert.match((await run('show', 'merge.risk')).out, /seq 1 · merge\.risk/)
  const missing = await run('show', 'nope')
  assert.equal(missing.code, 1, missing.out)
  assert.match(missing.out, /no audit decision nope for case audit/)

  // outcome: records a human verdict for calibration; JSON shape and usage errors.
  const recorded = await run('outcome', 'plan.risk', 'defect', '--note', 'the destructive step was real')
  assert.equal(recorded.code, 0, recorded.out)
  assert.match(recorded.out, /Recorded outcome for plan\.risk \(seq 0\): expected shadow, observed defect · the destructive step was real/)
  const outcomeJson = JSON.parse((await run('outcome', 'merge.risk', 'pass', '--json')).out)
  assert.equal(outcomeJson.payload.id, 'merge.risk')
  assert.equal(outcomeJson.payload.target, 1)
  assert.equal(outcomeJson.payload.observed, 'pass')
  assert.equal(outcomeJson.payload.source, 'human')
  const badVerdict = await run('outcome', 'plan.risk', 'maybe')
  assert.equal(badVerdict.code, 2, badVerdict.out)
  assert.match(badVerdict.out, /verdict must be one of allow, ask, block, defect, pass/)

  // calibrate: below the minimum, JSON shape, then enough outcomes for a Brier score.
  const low = await run('calibrate')
  assert.equal(low.code, 0, low.out)
  assert.match(low.out, /insufficient outcomes: 2 sample\(s\)/)
  const calib = JSON.parse((await run('calibrate', '--json')).out)
  assert.equal(calib.case, 'audit')
  assert.equal(calib.n, 2)
  assert.equal(calib.sufficient, false)
  assert.equal(typeof calib.brier, 'number')
  assert.equal(calib.bins.length, 5)
  for (let n = 0; n < 3; n += 1) assert.equal((await run('outcome', 'plan.risk', 'pass')).code, 0)
  const enough = await run('calibrate')
  assert.equal(enough.code, 0, enough.out)
  assert.match(enough.out, /Calibration: 5 sample\(s\)/)
  assert.match(enough.out, /Brier score: \d\.\d{3}/)
  const enoughJson = JSON.parse((await run('calibrate', '--json')).out)
  assert.equal(enoughJson.sufficient, true)
  assert.ok(enoughJson.suggestions.length > 0)

  // A middle record edited after the chain was sealed: verify refuses it with
  // the record number, and no command appends past the break.
  const lines = readFileSync(w.ledger, 'utf8').trimEnd().split('\n')
  const tampered = JSON.parse(lines[1])
  tampered.payload.reason = 'edited after the fact'
  lines[1] = JSON.stringify(tampered)
  writeFileSync(w.ledger, `${lines.join('\n')}\n`)
  const broken = await run('verify')
  assert.equal(broken.code, 1, broken.out)
  assert.match(broken.out, /BROKEN at record 1/)
  assert.match(broken.out, /hash mismatch/)
  const brokenJson = JSON.parse((await run('verify', '--json')).out)
  assert.equal(brokenJson.ok, false)
  assert.equal(brokenJson.brokenAt, 1)
  assert.equal(brokenJson.length, 1, 'only the records before the break verify')
  assert.equal((await run('report')).code, 1, 'the report keeps the broken chain visible')
  const refusedOutcome = await run('outcome', 'plan.risk', 'pass')
  assert.equal(refusedOutcome.code, 1, refusedOutcome.out)
  assert.match(refusedOutcome.out, /audit ledger is broken at record 1/)

  // usage: a missing or unknown action exits 2 without touching the case.
  const noAction = await execute('audit', ['-m', 'audit'], w.r)
  assert.equal(noAction.code, 2, noAction.out)
  const unknown = await run('bogus')
  assert.equal(unknown.code, 2, unknown.out)
  assert.match(unknown.out, /choose verify, report, show, outcome, calibrate/)
})

// ---- `attest stage audit` (qa/task-6): the workflow audit stage must do real
// work — verify the chain, record a fidelity decision per finished result and
// write the report — instead of only moving a marker; enforce mode must stop
// the stage on a block.
const stageWorld = (t, auditBlock) => {
  const base = mkdtempSync(join(tmpdir(), 'attest-stage-audit-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  const home = join(base, 'home')
  mkdirSync(join(root, 'docs/cases/audit'), { recursive: true })
  mkdirSync(join(root, '.attest/agents'), { recursive: true })
  mkdirSync(home)
  writeFileSync(join(root, '.attest/agents/fake.yaml'), 'command: fake\nmodel: []\neffort: []\npermission:\n  - [--policy]\nprompt: last-arg\n')
  writeFileSync(join(root, 'docs/cases/audit/plan.md'), `# Stage audit
\`\`\`yaml
attest: 1
goal: "Stage audit records evidence"
base: main
audit:
${auditBlock}
roles:
  api:
    agent: fake
    flags: [--policy, ask]
    touches: []
\`\`\`

## Done when

- It works.

## Role: api

Do it.
`)
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  gitIn(root, 'init', '-q', '-b', 'main')
  gitIn(root, 'config', 'user.name', 'Probe')
  gitIn(root, 'config', 'user.email', 'probe@example.invalid')
  gitIn(root, 'add', '.')
  gitIn(root, 'commit', '-qm', 'initial')
  const r = runtime({ cwd: root, home })
  const m = caseOf(r, 'audit')
  append(m.log, 'cli', { ev: 'dispatch', role: 'api', agent: 'fake', session: '$1', window: '@1', pane: '%1', owner: 'owner', worktree: root, branch: 'role/audit/api', base: 'main', argv: ['fake'] })
  mkdirSync(join(root, '.attest'), { recursive: true })
  return { base, root, home, r, m, resultFile: join(root, '.attest/result.md') }
}

test('stage audit verifies the chain, records a result.fidelity decision per finished result and writes the report', { timeout: 30000 }, async t => {
  const w = stageWorld(t, '  mode: shadow\n  provider: heuristic')
  writeFileSync(w.resultFile, '---\nstatus: done\nsummary: "the endpoint works"\n---\nNo command output, no commits, no evidence.')
  // A pre-existing decision makes the stage's chain verify append its own record.
  const ledger = ledgerPath(w.m.common, 'audit')
  appendDecision(ledger, auditDecision('plan.risk', 0, 0.2, 'low', 'shadow', 'the plan is small'))
  const staged = await execute('stage', ['audit', '-m', 'audit'], w.r)
  assert.equal(staged.code, 0, staged.out)
  assert.match(staged.out, /Stage: audit/)
  assert.match(staged.out, /OK 1 records/)
  assert.match(staged.out, /Verify record 1 appended/)
  assert.match(staged.out, /result\.fidelity/)
  assert.match(staged.out, /Audit report: .*docs\/cases\/audit\/audit\.md/)
  assert.match(staged.out, /risk \w+ · allow \d+ · ask \d+ · block \d+ · shadow \d+/)
  const reportFile = join(w.root, 'docs/cases/audit/audit.md')
  assert.equal(existsSync(reportFile), true)
  assert.match(readFileSync(reportFile, 'utf8'), /# Audit: audit/)
  assert.match(readFileSync(reportFile, 'utf8'), /result\.fidelity/)
  assert.equal(readLog(w.m.log).events.at(-1).ev, 'stage')
  assert.equal(readLog(w.m.log).events.at(-1).stage, 'audit')
  const records = readFileSync(ledger, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  assert.equal(records.filter(one => one.type === 'audit-verify').length, 1, 'the stage appends its audit-verify record')
  const decisions = records.filter(one => one.type === 'audit-decision')
  assert.equal(decisions.some(one => one.payload.id === 'result.fidelity'), true, 'the stage records a fidelity decision')
  assert.equal(decisions.every(one => one.payload.action === 'shadow'), true, 'shadow mode records but never refuses')

  // Tampering with a middle record makes the stage refuse before it moves.
  const stages = () => readLog(w.m.log).events.filter(event => event.ev === 'stage' && event.stage === 'audit').length
  const before = stages()
  const tampered = JSON.parse(readFileSync(ledger, 'utf8').trimEnd().split('\n')[1])
  tampered.payload.length = 99
  const lines = readFileSync(ledger, 'utf8').trimEnd().split('\n')
  lines[1] = JSON.stringify(tampered)
  writeFileSync(ledger, `${lines.join('\n')}\n`)
  const broken = await execute('stage', ['audit', '-m', 'audit'], w.r)
  assert.equal(broken.code, 1, broken.out)
  assert.match(broken.out, /BROKEN at record 1/)
  assert.match(broken.out, /hash mismatch/)
  assert.equal(stages(), before, 'a broken chain leaves the stage where it was')
})

test('stage audit in enforce mode stops on a blocked result and does not move the stage', { timeout: 30000 }, async t => {
  const w = stageWorld(t, '  mode: enforce\n  provider: heuristic')
  writeFileSync(w.resultFile, '---\nstatus: failed\nsummary: "x"\n---\ny')
  const staged = await execute('stage', ['audit', '-m', 'audit'], w.r)
  assert.equal(staged.code, 1, staged.out)
  assert.match(staged.out, /result\.fidelity/)
  assert.match(staged.out, /block|ask/)
  assert.equal(readLog(w.m.log).events.some(event => event.ev === 'stage' && event.stage === 'audit'), false, 'a blocked stage does not move')
  assert.equal(existsSync(join(w.root, 'docs/cases/audit/audit.md')), false, 'no report is written after a block')
  const ledger = ledgerPath(w.m.common, 'audit')
  const decisions = readFileSync(ledger, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)).filter(one => one.type === 'audit-decision')
  assert.equal(decisions.some(one => one.payload.id === 'result.fidelity' && one.payload.band === 'high'), true)
})
