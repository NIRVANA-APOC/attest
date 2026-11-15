#!/usr/bin/env node
// Refuses the retired project identity anywhere in the repository. The banned
// strings are assembled at runtime so this checker does not contain them.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const banned = [['tro', 'upe'].join(''), ['trou', 'ple'].join(''), ['hiti', 'anqi'].join(''), ['tianq', 'iz'].join(''), ['Prover', 'Technology'].join('-')]
const skip = new Set(['node_modules', 'dist', '.git', '.npm-cache', '.attest', '.scratch', '.tools'])
const files = []
const walk = dir => {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path)
    else if (!/\.(png|jpe?g|gif|ico|webp|woff2?|mp4|webm|mov|mkv|zip|tgz|gz|pdf|ttf|otf)$/i.test(name)) files.push(path)
  }
}
walk(process.cwd())

let bad = 0
for (const file of files) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    for (const word of banned) {
      const at = line.toLowerCase().indexOf(word)
      if (at >= 0) {
        bad += 1
        console.error(`${relative(process.cwd(), file)}:${index + 1}: retired identity "${word}"`)
      }
    }
  })
}
if (bad > 0) {
  console.error(`\ncheck-names: ${bad} occurrence(s) of the retired project identity.`)
  process.exit(1)
}
console.log(`check-names: clean (${files.length} files)`)
