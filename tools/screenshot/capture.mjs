#!/usr/bin/env node
// Capture the real Attest panel into docs/media/*.png.
//
// The frames this writes are not mockups: every one is a screenshot of a live
// `node dist/cli.js panel` process, captured from its tmux pane with
// `tmux capture-pane -ep` and rendered by tools/screenshot/render.py. What is
// scripted is the agents: they are tiny stand-ins (demo/agent.mjs, registered
// through repository adapter files) so the frames can be reproduced without
// Claude Code or Codex signed in. The case, plan, approvals, dispatches, run
// log, commits, results and audit ledger all go through the real CLI and the
// real modules.
//
// Usage:
//   node tools/screenshot/capture.mjs [options]
//
// Options:
//   --cli <path>     built CLI to drive (default: <repo>/dist/cli.js)
//   --out <dir>      where the PNGs go (default: <repo>/docs/media)
//   --work <dir>     scratch directory (default: $TMPDIR/attest-screenshots)
//   --python <path>  Python with Pillow + fontTools (default: python3)
//   --plan <path>    case plan to use (default: examples/demo/docs/cases/<case>/plan.md)
//   --case <name>    case name (default: storefront-search)
//   --socket <name>  tmux socket for the run (default: attest-screenshot)
//   --keep           keep the scratch directory and the tmux server for inspection
//   --no-audit       skip the audit-page frame (for early runs before the Jev module lands)
//
// Requirements: tmux, git, node >= 20, and Python with Pillow + fontTools:
//   python3 -m venv .tools/venv && .tools/venv/bin/pip install pillow fonttools
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined && !args[at + 1].startsWith('--') ? args[at + 1] : fallback
}
const flag = name => args.includes(`--${name}`)

const CLI = resolve(option('cli', join(ROOT, 'dist/cli.js')))
const CASE = option('case', 'storefront-search')
const OUT = resolve(option('out', join(ROOT, 'docs/media')))
const WORK = resolve(option('work', join(process.env.TMPDIR ?? '/tmp', 'attest-screenshots')))
const PYTHON = option('python', 'python3')
const PLAN = resolve(option('plan', join(ROOT, 'examples/demo/docs/cases', CASE, 'plan.md')))
const SOCKET = option('socket', 'attest-screenshot')
const KEEP = flag('keep')
const AUDIT = !flag('no-audit')

const REPO = join(WORK, 'repo')
const HOME_EN = join(WORK, 'home')
const HOME_ZH = join(WORK, 'home-zh')
const BIN = join(WORK, 'bin')
const FRAMES = join(WORK, 'frames')
const AGENT = join(HERE, 'demo/agent.mjs')

const WS = 'storefront'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const say = (...parts) => console.log('[screenshot]', ...parts)
const die = message => { throw new Error(message) }

const run = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })

const must = (command, commandArgs, options = {}) => {
  const result = run(command, commandArgs, options)
  if (result.error !== undefined) die(`${command}: ${result.error.message}`)
  if (result.status !== 0) die(`${command} ${commandArgs.join(' ')} failed (${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result
}

const shellQuote = text => `'${String(text).replaceAll("'", "'\\''")}'`

/** The environment of a pane and of every CLI it runs; tmux passes it on. */
const paneEnv = (home, extra = {}) => ({
  ...process.env,
  HOME: home,
  PATH: `${BIN}:${process.env.PATH ?? ''}`,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  ATTEST_TMUX_SOCKET: SOCKET,
  ATTEST_PANEL_GRADIENT: '0', // a still frame does not need the animated gradient
  ...extra,
})

const tmux = (commandArgs, options = {}) => must('tmux', ['-L', SOCKET, ...commandArgs], options)

const listPanes = () => tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{@attest-panel}\t#{session_name}\t#{window_name}']).stdout
  .split('\n').filter(Boolean).map(line => {
    const [pane, panel = '', session = '', window = ''] = line.split('\t')
    return { pane, panel, session, window }
  })

const capture = (pane, name) => {
  const file = join(FRAMES, `${name}.ansi`)
  const result = tmux(['capture-pane', '-ep', '-t', pane])
  writeFileSync(file, result.stdout)
  say(`captured ${name}.ansi (${result.stdout.split('\n').length} rows)`)
  return file
}

const paneText = pane => tmux(['capture-pane', '-p', '-t', pane]).stdout

const waitFor = async (pane, pattern, what, timeout = 20000) => {
  const until = Date.now() + timeout
  for (;;) {
    const text = paneText(pane)
    if (pattern.test(text)) return text
    if (Date.now() > until) die(`timed out waiting for ${what}\n--- pane ${pane} ---\n${text.slice(-3000)}`)
    await sleep(120)
  }
}

const sendText = (pane, text) => tmux(['send-keys', '-l', '-t', pane, text])
const sendKey = (pane, key) => tmux(['send-keys', '-t', pane, key])

/** Run one CLI command in the pane's shell and wait until its success line shows. */
const cli = async (pane, command, expect, what) => {
  sendText(pane, command)
  sendKey(pane, 'Enter')
  return waitFor(pane, expect, what ?? command)
}

const paneOf = session => listPanes().find(one => one.session === session)?.pane ?? die(`no pane in session ${session}`)

const panelSession = async (name, home, extraEnv = {}) => {
  const command = `env HOME=${shellQuote(home)} LANG=C.UTF-8 node ${shellQuote(CLI)} panel -m ${shellQuote(CASE)} --no-anim`
  tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', REPO, command], { env: paneEnv(home, extraEnv) })
  const pane = paneOf(name)
  // The panel paints its first frame once it has read the case; wait for the case name in the title bar.
  await waitFor(pane, new RegExp(CASE.replaceAll('-', '\\-')), `panel ${name}`)
  await sleep(500)
  return pane
}

const killSession = name => run('tmux', ['-L', SOCKET, 'kill-session', '-t', name], { env: paneEnv(HOME_EN) })

const render = (frame, out) => {
  mkdirSync(dirname(out), { recursive: true })
  const result = must(PYTHON, [join(HERE, 'render.py'), frame, out, '--scale', '2'])
  say(result.stdout.trim())
}

const copyTree = (from, to) => {
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const target = join(to, entry)
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true })
      copyTree(source, target)
    } else {
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target)
    }
  }
}

const git = (cwd, gitArgs) => must('git', ['-c', 'user.name=Demo Person', '-c', 'user.email=demo@example.com', ...gitArgs], { cwd })

/** The fake agent: a wrapper the adapter files point at, running the checked-in script. */
const writeAgentWrapper = () => {
  const wrapper = join(BIN, 'agent')
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(AGENT)} "$@"\n`)
  chmodSync(wrapper, 0o755)
}

/** Repository adapter files that override the built-in agents for the demo only. */
const adapterYaml = (agent, badge) => {
  const model = agent === 'codex' ? 'model: ["-m", "{model}"]' : 'model: ["--model", "{model}"]'
  const effort = agent === 'codex' ? 'effort: ["-c", \'model_reasoning_effort="{effort}"\']' : 'effort: ["--effort", "{effort}"]'
  const permission = agent === 'codex'
    ? 'permission:\n  - ["-a", "--ask-for-approval", "--dangerously-bypass-approvals-and-sandbox"]\n  - ["-s", "--sandbox", "--dangerously-bypass-approvals-and-sandbox"]'
    : 'permission:\n  - ["--permission-mode", "--dangerously-skip-permissions"]'
  return `# Written by tools/screenshot/capture.mjs for the demo case only.
command: ${JSON.stringify(join(BIN, 'agent'))}
${model}
${effort}
${permission}
prompt: last-arg
paste: bracketed
screen:
  waits: ['Do you want to proceed\\?']
  working: ['esc to interrupt']
  ready: ['^❯ *$']
badge:
  glyph: ${JSON.stringify(badge.glyph)}
  tone: ${badge.tone}
`
}

/** Write what a role did: its changed files, a commit and the result it left. */
const roleDid = (role, message) => {
  const worktree = join(REPO, '.attest/worktrees', CASE, role)
  if (!existsSync(worktree)) die(`role ${role} has no worktree at ${worktree}`)
  const fixtures = join(HERE, 'demo/work', role)
  if (existsSync(fixtures)) copyTree(fixtures, worktree)
  git(worktree, ['add', '-A'])
  // A reviewer changes no files: only commit when there is something staged.
  if (run('git', ['-c', 'user.name=Demo Person', '-c', 'user.email=demo@example.com', 'diff', '--cached', '--quiet'], { cwd: worktree }).status !== 0) {
    git(worktree, ['commit', '-qm', message])
  }
  const result = join(HERE, 'demo/results', `${role}.md`)
  if (existsSync(result)) {
    mkdirSync(join(worktree, '.attest'), { recursive: true })
    cpSync(result, join(worktree, '.attest/result.md'))
  }
}

const main = async () => {
  if (!existsSync(CLI)) die(`${CLI} does not exist; run npm run build first (or pass --cli <path>)`)
  if (!existsSync(PLAN)) die(`no plan at ${PLAN}; pass --plan <path>`)
  for (const [what, command, commandArgs] of [
    ['tmux', 'tmux', ['-V']],
    ['git', 'git', ['--version']],
    ['node', process.execPath, ['--version']],
  ]) {
    const found = run(command, commandArgs)
    if (found.error !== undefined) die(`${what} is required: ${found.error.message}`)
  }
  const pillow = run(PYTHON, ['-c', 'import PIL, fontTools; print("ok")'])
  if (pillow.status !== 0) die(`${PYTHON} needs Pillow and fontTools: python3 -m venv .tools/venv && .tools/venv/bin/pip install pillow fonttools\n${pillow.stderr ?? ''}`)

  // The work directory is ours to delete; never let a typo point it at a checkout.
  if (existsSync(WORK)) {
    if (!existsSync(join(WORK, '.attest-screenshots-work'))) die(`refusing to delete ${WORK}: it is not a screenshot work directory`)
    rmSync(WORK, { recursive: true, force: true })
  }
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(WORK, '.attest-screenshots-work'), 'created by tools/screenshot/capture.mjs\n')
  mkdirSync(FRAMES, { recursive: true })
  mkdirSync(BIN, { recursive: true })

  say(`work ${WORK}`)
  say(`cli ${CLI}`)

  // 1. The scratch repository: a small storefront at the commit the case is cut from.
  mkdirSync(REPO, { recursive: true })
  copyTree(join(HERE, 'demo/repo'), REPO)
  writeFileSync(join(REPO, '.gitignore'), 'node_modules/\n')
  git(REPO, ['init', '-q', '-b', 'main'])
  git(REPO, ['config', 'user.name', 'Demo Person'])
  git(REPO, ['config', 'user.email', 'demo@example.com'])
  git(REPO, ['add', '-A'])
  git(REPO, ['commit', '-qm', 'atlas storefront: catalog, header, light tokens'])
  writeAgentWrapper()

  // A panel for the demo's language switch; the default locale stays English.
  mkdirSync(join(HOME_ZH, '.config/attest'), { recursive: true })
  writeFileSync(join(HOME_ZH, '.config/attest/settings.json'), `${JSON.stringify({ language: 'zh' }, null, 2)}\n`)

  // 2. A fresh tmux server on a dedicated socket, with one shell pane as the orchestrator's terminal.
  run('tmux', ['-L', SOCKET, 'kill-server'], { env: paneEnv(HOME_EN) })
  tmux(['new-session', '-d', '-s', 'cli', '-x', '120', '-y', '40', '-c', REPO, 'bash', '--noprofile', '--norc', '-i'], { env: paneEnv(HOME_EN) })
  const shell = paneOf('cli')

  // 3. `attest case new`: the real command, creating the worktree and binding this pane.
  await cli(shell, `node ${shellQuote(CLI)} case new ${CASE}`, new RegExp(`Case ${CASE}:`), 'case new')
  say('case created')
  // It opens a panel beside the caller; the frames below start their own panels at a known size.
  for (const one of listPanes()) if (one.panel !== '') run('tmux', ['-L', SOCKET, 'kill-pane', '-t', one.pane], { env: paneEnv(HOME_EN) })

  // 4. The plan and the demo adapters, in the case worktree the plan is read from.
  const worktree = join(REPO, '.attest/cases', CASE)
  const planPath = join(worktree, 'docs/cases', CASE, 'plan.md')
  mkdirSync(dirname(planPath), { recursive: true })
  cpSync(PLAN, planPath)
  const adapters = join(worktree, '.attest/agents')
  mkdirSync(adapters, { recursive: true })
  writeFileSync(join(adapters, 'claude.yaml'), adapterYaml('claude', { glyph: '✻', tone: 'coral' }))
  writeFileSync(join(adapters, 'codex.yaml'), adapterYaml('codex', { glyph: '⬢', tone: 'cyan' }))
  const clean = await cli(shell, `node ${shellQuote(CLI)} check -m ${CASE}`, /clean \(4 roles: search, theme, review, auditor\)/, 'attest check')
  if (!/clean \(4 roles/.test(clean)) die(`the demo plan does not check cleanly:\n${clean.slice(-2500)}`)
  say('plan checks cleanly')

  // 5. The plan gate, as the person first sees it: no approval yet, the panel waiting on them.
  await cli(shell, `node ${shellQuote(CLI)} gate plan "Approve this split and the three decisions?" --no-wait`, /Opened gate plan/, 'gate plan')
  const planPanel = await panelSession('panel-plan', HOME_EN)
  await waitFor(planPanel, /APPROVE THE PLAN/, 'the plan gate box')
  const framePlan = capture(planPanel, 'panel-plan-en')
  killSession('panel-plan')

  // 6. Approve from a terminal, which is the only place approval is allowed.
  sendText(shell, `node ${shellQuote(CLI)} approve -m ${CASE}`)
  sendKey(shell, 'Enter')
  await waitFor(shell, /Approve\? \[y\/N\]/, 'the approval prompt')
  sendText(shell, 'y')
  sendKey(shell, 'Enter')
  await waitFor(shell, /Approved /, 'the approval')
  await cli(shell, `node ${shellQuote(CLI)} stage build`, /Stage: build/, 'stage build')
  say('plan approved, stage build')

  // 7. Dispatch the two builders, then give each the commit and result a real role would leave.
  for (const role of ['search', 'theme']) {
    await cli(shell, `node ${shellQuote(CLI)} dispatch ${role}`, new RegExp(`Dispatched ${role}`), `dispatch ${role}`)
    await sleep(400)
  }
  roleDid('search', `search: header search box filters the catalog as you type

Adds the SearchBox, client-side catalog matching over the loaded catalog,
keyboard navigation, and mounts it in the header.`)
  roleDid('theme', `theme: dark token layer follows prefers-color-scheme

Adds theme/tokens.css with every surface and text token, imports it first
in globals.css so first paint is already dark, and styles the search
suggestions through the tokens.`)
  say('builders committed their work and wrote results')

  await cli(shell, `node ${shellQuote(CLI)} stage review`, /Stage: review/, 'stage review')
  await cli(shell, `node ${shellQuote(CLI)} dispatch review`, /Dispatched review/, 'dispatch review')
  await sleep(600)
  say('reviewer dispatched and waiting on the person')

  // 8. The case page, in English.
  const enPanel = await panelSession('panel-en', HOME_EN)
  await waitFor(enPanel, /Search products|search/, 'the case page', 15000)
  const frameCase = capture(enPanel, 'panel-case-en')
  sendKey(enPanel, '2')
  await sleep(500)
  const frameRoles = capture(enPanel, 'panel-roles-en')
  killSession('panel-en')

  // 9. The same case page in Chinese: a real settings choice, read by the real panel.
  const zhPanel = await panelSession('panel-zh', HOME_ZH)
  await waitFor(zhPanel, /中\/EN/, 'the Chinese panel', 15000)
  await sleep(700)
  const frameCaseZh = capture(zhPanel, 'panel-case-zh')
  killSession('panel-zh')

  // 10. Finish the review, run the real audit stage, and capture the AUDIT page.
  let frameAudit
  if (AUDIT) {
    roleDid('review', 'review: both branches pass')
    await cli(shell, `node ${shellQuote(CLI)} stage audit`, /Stage: audit/, 'stage audit')
    // Record a few human verdicts so the page shows calibration rather than the empty state.
    for (const [decision, verdict, note] of [
      ['plan.risk', 'pass', 'the split held; no work outside the touches'],
      ['role.boundary', 'pass', 'both builders stayed inside their trees'],
      ['result.fidelity', 'pass', 'every result named a command or path'],
      ['merge.risk', 'pass', 'reviewed branch by branch, one fix round'],
    ]) {
      await cli(shell, `node ${shellQuote(CLI)} audit outcome ${decision} ${verdict} --note ${shellQuote(note)}`, /Recorded outcome/, `audit outcome ${decision}`)
    }
    await cli(shell, `node ${shellQuote(CLI)} gate mr-ok "Merge the two reviewed branches and open the MR?" --no-wait`, /Opened gate mr-ok/, 'gate mr-ok')
    const auditPanel = await panelSession('panel-audit', HOME_EN)
    sendKey(auditPanel, '6')
    await sleep(900)
    // Select the newest merge.risk decision so the detail column shows a real reason and digest.
    sendKey(auditPanel, 'j')
    await sleep(400)
    frameAudit = capture(auditPanel, 'panel-audit-en')
    killSession('panel-audit')
  } else {
    say('skipping the audit page (--no-audit)')
  }

  // 11. Render the frames to the PNGs the READMEs reference.
  mkdirSync(OUT, { recursive: true })
  const media = {
    'panel-plan-en': 'panel-plan-en.png',
    'panel-case-en': 'panel-case-en.png',
    'panel-roles-en': 'panel-roles-en.png',
    'panel-case-zh': 'panel-case-zh.png',
  }
  if (frameAudit !== undefined) media['panel-audit-en'] = 'panel-audit-en.png'
  const rendered = []
  for (const [frame, name] of Object.entries(media)) {
    const out = join(OUT, name)
    render(join(FRAMES, `${frame}.ansi`), out)
    rendered.push(out)
  }

  if (KEEP) say(`kept ${WORK} and tmux -L ${SOCKET}`)
  else {
    run('tmux', ['-L', SOCKET, 'kill-server'], { env: paneEnv(HOME_EN) })
  }
  say('done')
  for (const file of rendered) say(`  ${file}`)
  return rendered
}

try {
  await main()
} catch (error) {
  console.error(`[screenshot] ${error instanceof Error ? error.message : String(error)}`)
  if (!KEEP) run('tmux', ['-L', SOCKET, 'kill-server'], { env: paneEnv(HOME_EN) })
  else console.error(`[screenshot] kept ${WORK} and tmux -L ${SOCKET} for inspection`)
  process.exitCode = 1
}
