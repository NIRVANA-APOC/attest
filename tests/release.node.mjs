// Independent release verification (qa/task-6): the published npm package must
// contain what it claims (dist, skills, NOTICE, no sources/tests), install and
// run as `attest` 0.1.0 from a throwaway project, install/remove its skill into
// an isolated HOME without ever overwriting a directory it does not own, and
// contain none of the retired project identity.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repo = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
// Assembled at runtime, like scripts/check-names.mjs, so this file does not
// itself contain the strings it refuses.
const RETIRED_WORD = ['tro', 'upe'].join('')
const RETIRED_MISSPELLING = ['trou', 'ple'].join('')
const RETIRED_PEOPLE = [['hit', 'ianqi'].join(''), ['Tianqi', 'Zhao'].join(' ')]
const retired = (text) => [RETIRED_WORD, RETIRED_MISSPELLING].some(word => text.toLowerCase().includes(word))
  || RETIRED_PEOPLE.some(name => text.toLowerCase().includes(name.toLowerCase()))
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|tgz|zip|gz|pdf|mp4|webm)$/i
const SKIP_DIR = new Set(['node_modules', '.git', '.npm-cache', '.attest', '.qa-logs', 'coverage'])

const workspace = () => mkdtempSync(join(tmpdir(), 'attest-release-'))
const npmCache = () => join(repo, '.npm-cache')

/** npm pack --json is an object keyed by package name on npm >= 12 and an array on npm 10. */
const packInto = (destination) => {
  const out = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, npm_config_cache: npmCache() },
  })
  const parsed = JSON.parse(out)
  const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  assert.ok(record, 'npm pack printed a package record')
  return { path: join(destination, record.filename), files: record.files.map(file => file.path), size: record.size }
}

const installTarball = (tarball) => {
  const project = workspace()
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'attest-release-probe', version: '0.0.0', private: true }, null, 2)}\n`)
  execFileSync('npm', ['install', tarball, '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: project, encoding: 'utf8', env: { ...process.env, npm_config_cache: npmCache() },
  })
  return project
}

const installedCli = (project) => join(project, 'node_modules/attest/dist/cli.js')

test('npm pack contains dist, skills and NOTICE but no sources, tests or caches; it installs and runs as attest 0.1.0', { timeout: 180000 }, t => {
  const directory = workspace()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const tarball = packInto(directory)
  t.after(() => rmSync(tarball.path, { force: true }))

  assert.equal(pkg.name, 'attest')
  assert.equal(pkg.version, '0.1.0')
  assert.deepEqual(pkg.bin, { attest: 'dist/cli.js' })
  for (const required of ['package.json', 'NOTICE', 'LICENSE', 'dist/cli.js', 'dist/commands.js', 'dist/jev/types.js', 'skills/attest-case/SKILL.md', 'skills/attest-case/stages.yaml', 'skills/attest-case/templates/plan.md', 'skills/attest-case/roles/builder.md']) {
    assert.ok(tarball.files.includes(required), `tarball is missing ${required}`)
  }
  assert.ok(tarball.files.filter(file => file.startsWith('dist/') && file.endsWith('.js')).length >= 20, 'the built dist ships every module')
  for (const file of tarball.files) {
    assert.doesNotMatch(file, /^(src|tests|tools|examples|\.github|\.attest|node_modules|\.npm-cache|docs\/dev)\//, `tarball leaks ${file}`)
    assert.ok(!BINARY.test(file) || file.startsWith('skills/'), `tarball ships an unexpected binary ${file}`)
  }
  assert.ok(tarball.size > 50_000 && tarball.size < 5_000_000, `tarball size ${tarball.size}`)

  const project = installTarball(tarball.path)
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const installed = JSON.parse(readFileSync(join(project, 'node_modules/attest/package.json'), 'utf8'))
  assert.equal(installed.name, 'attest')
  assert.equal(installed.version, '0.1.0')
  assert.equal(existsSync(installedCli(project)), true, 'the installed package has dist/cli.js')
  assert.equal(existsSync(join(project, 'node_modules/attest/skills/attest-case/SKILL.md')), true)
  assert.equal(existsSync(join(project, 'node_modules/attest/NOTICE')), true)
  for (const runtimeDependency of Object.keys(pkg.dependencies ?? {})) {
    assert.equal(existsSync(join(project, 'node_modules', runtimeDependency)), true, `installed dependency ${runtimeDependency}`)
  }

  const version = spawnSync('npx', ['--no-install', 'attest', '--version'], { cwd: project, encoding: 'utf8', env: { ...process.env, npm_config_cache: npmCache() } })
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), '0.1.0')
  const help = spawnSync('npx', ['--no-install', 'attest', '--help'], { cwd: project, encoding: 'utf8', env: { ...process.env, npm_config_cache: npmCache() } })
  assert.equal(help.status, 0, help.stderr)
  for (const command of ['setup', 'case', 'open', 'up', 'check', 'approve', 'gate', 'stage', 'dispatch', 'status', 'send', 'wait', 'close', 'teardown', 'panel', 'audit']) {
    assert.match(help.stdout, new RegExp(`^  ${command}\\b`, 'm'), `attest --help does not document ${command}`)
  }
  const unknown = spawnSync('npx', ['--no-install', 'attest', 'bogus'], { cwd: project, encoding: 'utf8', env: { ...process.env, npm_config_cache: npmCache() } })
  assert.equal(unknown.status, 2)
  assert.equal(unknown.stdout, '')
  assert.match(unknown.stderr, /unknown command 'bogus'/)
})

test('the installed package installs its skill into an isolated HOME and refuses to overwrite or remove a directory it does not own', { timeout: 120000 }, t => {
  const directory = workspace()
  const tarball = packInto(directory)
  const project = installTarball(tarball.path)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const home = join(directory, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const env = { ...process.env, HOME: home, npm_config_cache: npmCache() }
  const cli = installedCli(project)
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8', env })

  const installed = run('setup')
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  const target = join(home, '.claude/skills/attest-case')
  assert.equal(existsSync(join(target, 'SKILL.md')), true, installed.stdout)
  assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /^---\nname: attest-case/m)
  assert.equal(existsSync(join(target, '.attest-install.json')), true)
  assert.equal(existsSync(join(target, 'roles/builder.md')), true)

  const removed = run('setup', '--remove')
  assert.equal(removed.status, 0, removed.stdout)
  assert.equal(existsSync(target), false)
  const again = run('setup', '--remove')
  assert.equal(again.status, 0, again.stdout)
  assert.match(again.stdout, /Not installed:/)

  // An unmarked directory at the target is never overwritten or removed.
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'valuable.txt'), 'not attest\'s\n')
  for (const args of [['setup', '--remove'], ['setup']]) {
    const refused = run(...args)
    assert.equal(refused.status, 1, `${args.join(' ')} should refuse: ${refused.stdout}`)
    assert.match(refused.stdout, /no attest install marker/)
    assert.equal(readFileSync(join(target, 'valuable.txt'), 'utf8'), 'not attest\'s\n')
  }
})

const walk = (root, found = []) => {
  for (const name of readdirSync(root)) {
    if (SKIP_DIR.has(name)) continue
    const path = join(root, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, found)
    else if (!BINARY.test(name)) found.push(path)
  }
  return found
}

test('identity audit: the retired project word, its misspelling and its people appear nowhere in the repo, tarball or installed package', { timeout: 180000 }, t => {
  const directory = workspace()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const tarball = packInto(directory)
  const project = installTarball(tarball.path)
  t.after(() => rmSync(project, { recursive: true, force: true }))

  // 1. every text file in the repository: sources, built dist, docs, assets,
  //    skills, examples, tests, scripts, CI and package metadata.
  const leaks = []
  for (const path of walk(repo)) {
    const text = readFileSync(path, 'utf8')
    if (!retired(text)) continue
    text.split('\n').forEach((line, index) => { if (retired(line)) leaks.push(`${relative(repo, path)}:${index + 1}`) })
  }
  assert.deepEqual(leaks, [], `retired identity in: ${leaks.join(', ')}`)

  // 2. the published file list and the bytes that actually install.
  for (const file of tarball.files) assert.equal(retired(file), false, `retired identity in tarball path ${file}`)
  const installedLeaks = []
  for (const path of walk(join(project, 'node_modules/attest'))) {
    const text = readFileSync(path, 'utf8')
    if (!retired(text)) continue
    text.split('\n').forEach((line, index) => { if (retired(line)) installedLeaks.push(`${relative(project, path)}:${index + 1}`) })
  }
  assert.deepEqual(installedLeaks, [], `retired identity in installed package: ${installedLeaks.join(', ')}`)

  // 3. scripts/check-names.mjs only assembles the word and one misspelling; the
  //    package metadata is the other place an old identity would survive.
  const manifest = JSON.parse(readFileSync(join(project, 'node_modules/attest/package.json'), 'utf8'))
  assert.equal(manifest.name, 'attest')
  assert.deepEqual(Object.keys(manifest.bin), ['attest'])
  assert.equal(retired(JSON.stringify(manifest)), false)
})
