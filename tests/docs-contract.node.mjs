// Independent documentation-contract verification (qa/task-6): the bilingual
// README/guides must document only commands the built CLI really accepts, every
// local image they reference must exist as PNG/SVG, the two languages must show
// the same screenshot set, and the "real runtime screenshots" must be real PNG
// renders rather than placeholders.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repo = fileURLToPath(new URL('..', import.meta.url))
const at = (...parts) => join(repo, ...parts)
const cli = at('dist/cli.js')
const read = (path) => readFileSync(path, 'utf8')

const help = () => {
  const run = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
}
const documentedCommands = () => new Set([...help().matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map(match => match[1]))

/** Local image paths referenced by markdown or HTML, in file order. */
const imagesIn = (path) => {
  const text = read(path)
  const found = []
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(match[1])
  for (const match of text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) found.push(match[1])
  return found.filter(url => !/^(?:[a-z]+:)?\/\//i.test(url) && !url.startsWith('data:'))
}
const resolveRef = (from, url) => join(dirname(from), decodeURIComponent(url.replace(/^<|>$/g, '').split('#')[0].split('?')[0]))
const pngSize = (path) => {
  const bytes = readFileSync(path)
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${relative(repo, path)} is not a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length }
}

/**
 * The commands a doc file promises, parsed only from shell lines in code fences
 * and from inline code spans that start with `attest`. Prose and shell comments
 * ("npm link   # your build of attest on the PATH") cannot invent a command.
 */
const commandsIn = (path) => {
  const text = read(path)
  const tokens = []
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const raw of (match[1] ?? '').split('\n')) {
      const line = raw.replace(/\s+#.*$/, '')
      for (const found of line.matchAll(/(?:^|[;&|]\s*|\$\s+)attest\s+([a-z][a-z-]*)/g)) tokens.push(found[1])
    }
  }
  for (const span of [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1] ?? '')) {
    const found = /^\s*(?:\$\s+)?attest\s+([a-z][a-z-]*)/.exec(span)
    if (found?.[1] !== undefined) tokens.push(found[1])
  }
  return tokens
}

test('documentation contract: README and guides reference only real commands, real images, identical screenshots in both languages', { timeout: 60000 }, () => {
  const readmes = [at('README.md'), at('README.zh-CN.md')]
  const guides = [at('docs/guide.md'), at('docs/guide.zh-CN.md')]
  for (const path of [...readmes, ...guides]) assert.equal(existsSync(path), true, `${relative(repo, path)} is missing`)

  // 1. Every `attest <command>` in code spans/fences is a command `attest --help` documents.
  const commands = documentedCommands()
  assert.ok(commands.has('audit'), 'attest --help documents the audit command')
  for (const path of [...readmes, ...guides, at('docs/jev-audit.md'), at('docs/jev-audit.zh-CN.md')].filter(existsSync)) {
    for (const command of new Set(commandsIn(path))) assert.ok(commands.has(command), `${relative(repo, path)} documents attest ${command}, which attest --help does not offer`)
  }

  // 2. Every local image exists and is a PNG or SVG.
  for (const path of [...readmes, ...guides]) {
    for (const url of imagesIn(path)) {
      const file = resolveRef(path, url)
      assert.equal(existsSync(file), true, `${relative(repo, path)} references missing image ${url}`)
      assert.equal(statSync(file).isFile(), true)
      assert.match(extname(file).toLowerCase(), /^\.(png|svg)$/, `${relative(repo, path)} references ${url}, which is not PNG or SVG`)
    }
  }

  // 3. Both READMEs show the same screenshots (real render captures, not mockups).
  const shots = (path) => imagesIn(path).map(url => basename(resolveRef(path, url))).sort()
  assert.deepEqual(shots(readmes[1]), shots(readmes[0]), 'README.zh-CN.md and README.md reference the same image set')
  const media = shots(readmes[0]).filter(name => /\.png$/i.test(name))
  assert.ok(media.length >= 2, `README embeds at least two runtime screenshots, found ${media.join(', ') || 'none'}`)
  assert.ok(media.some(name => /audit/i.test(name)), `README embeds an AUDIT screenshot, found ${media.join(', ')}`)
  for (const name of media) {
    const path = at('docs/media', name)
    assert.ok(existsSync(path), `README screenshot docs/media/${name} exists`)
    const size = pngSize(path)
    assert.ok(size.width >= 800 && size.height >= 400, `docs/media/${name} is ${size.width}x${size.height}; a real panel capture is at least 800x400`)
    assert.ok(size.bytes > 10_000, `docs/media/${name} is only ${size.bytes} B; a real capture is not a blank placeholder`)
  }
  assert.ok(readdirSync(at('docs/media')).some(name => /\.png$/i.test(name)), 'docs/media holds at least one PNG capture')
})
