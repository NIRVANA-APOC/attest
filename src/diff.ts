// A role's change as hunks: `git diff` text parsed per file, and the words
// that changed between a removed line and the added line paired with it.

export type DiffLine = { sign: ' ' | '+' | '-'; old?: number; new?: number; text: string }
export type Hunk = { head: string; lines: DiffLine[] }
export type FileStatus = 'M' | 'A' | 'D'
export type FileDiff = { path: string; status: FileStatus; add: number; del: number; hunks: Hunk[]; binary?: true; untracked?: true; cut?: true }

/** The most lines kept per file; the counts stay exact. */
const KEEP = 400

/** Git's C-style quoting of a path with special characters, undone. */
const unquote = (raw: string): string => {
  const simple: { [key: string]: string | undefined } = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' }
  let out = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i] ?? ''
    if (ch !== '\\') {
      out += ch
      i += 1
      continue
    }
    const next = raw[i + 1] ?? ''
    const named = simple[next]
    if (named !== undefined) {
      out += named
      i += 2
    } else if (/[0-7]/.test(next)) {
      // Bytes outside printable ASCII are octal escapes, one per byte: decode a run of them as UTF-8.
      const bytes: number[] = []
      while (raw[i] === '\\' && /[0-7]/.test(raw[i + 1] ?? '')) {
        const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1))?.[0] ?? ''
        bytes.push(Number.parseInt(octal, 8))
        i += 1 + octal.length
      }
      out += new TextDecoder().decode(Uint8Array.from(bytes))
    } else {
      out += next
      i += 2
    }
  }

  return out
}

/** A path from a patch header line (`+++ b/x`), quoted or not, with git's trailing tab when it holds spaces. */
const marked = (line: string, prefix: 'a/' | 'b/'): string | undefined => {
  const raw = line.slice(4).replace(/\t$/, '')
  const path = raw.startsWith('"') ? (() => {
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw)?.[1]

    return quoted === undefined ? undefined : unquote(quoted)
  })() : raw

  return path?.startsWith(prefix) === true ? path.slice(prefix.length) : undefined
}

/** The file a `diff --git` line names: both sides are quoted when either needs it; with --no-renames both are the same path. */
const headerPath = (line: string): string => {
  const rest = line.slice('diff --git '.length)
  const quoted = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest)
  if (quoted !== null) {
    const path = unquote(quoted[2] ?? '')

    return path.startsWith('b/') ? path.slice(2) : path
  }
  if (rest.startsWith('a/')) {
    const both = rest.slice(2)
    const split = both.indexOf(' b/')
    // b/<path> follows a/<path> exactly, spaces included; comparing the halves keeps a path holding " b/" intact.
    if (split >= 0 && both.slice(0, split) === both.slice(split + 3)) return both.slice(0, split)
  }

  return rest
}

/** `git diff --no-color --no-renames` output, file by file. */
export const parseDiff = (text: string): FileDiff[] => {
  const files: FileDiff[] = []
  let file: FileDiff | undefined
  let hunk: Hunk | undefined
  let old = 0
  let now = 0
  let kept = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // The `+++ b/` line below names it exactly; this is for a file with no hunks (binary, mode only).
      file = { path: headerPath(line), status: 'M', add: 0, del: 0, hunks: [] }
      files.push(file)
      hunk = undefined
      kept = 0
      continue
    }
    if (file === undefined) continue
    if (hunk === undefined) {
      if (line.startsWith('new file mode')) file.status = 'A'
      else if (line.startsWith('deleted file mode')) file.status = 'D'
      else if (line.startsWith('Binary files ')) file.binary = true
      else {
        const path = line.startsWith('+++ b/') || line.startsWith('+++ "b/') ? marked(line, 'b/') : line.startsWith('--- a/') || line.startsWith('--- "a/') ? marked(line, 'a/') : undefined
        if (path !== undefined && path !== '/dev/null') file.path = path
      }
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (at !== null) {
      old = Number(at[1])
      now = Number(at[2])
      hunk = { head: line, lines: [] }
      if (kept < KEEP) file.hunks.push(hunk)
      continue
    }
    if (hunk === undefined || line.startsWith('\\')) continue
    const sign = line[0]
    if (sign !== ' ' && sign !== '+' && sign !== '-') continue
    const one: DiffLine = sign === '+' ? { sign, new: now++, text: line.slice(1) } : sign === '-' ? { sign, old: old++, text: line.slice(1) } : { sign: ' ', old: old++, new: now++, text: line.slice(1) }
    if (sign === '+') file.add += 1
    if (sign === '-') file.del += 1
    if (kept < KEEP) hunk.lines.push(one)
    else file.cut = true
    kept += 1
  }

  return files
}

/** A new file not in git yet, as one hunk of added lines. */
export const addedFile = (path: string, text: string): FileDiff => {
  const lines = text.replace(/\n$/, '').split('\n')
  const shown = lines.slice(0, KEEP).map((line, i): DiffLine => ({ sign: '+', new: i + 1, text: line }))

  return { path, status: 'A', add: text === '' ? 0 : lines.length, del: 0, untracked: true, hunks: text === '' ? [] : [{ head: `@@ -0,0 +1,${lines.length} @@`, lines: shown }], ...(lines.length > KEEP && { cut: true as const }) }
}

/** A line as pieces, the changed ones marked. */
export type Piece = { text: string; changed?: true }

const tokens = (text: string) => text.match(/\w+|\s+|[^\w\s]/g) ?? []

/**
 * The changed words between a removed line and its added line, by the longest common run of tokens.
 * Undefined when the lines share too little for word marks to help, or are too long to compare.
 */
export const wordDiff = (before: string, after: string): [Piece[], Piece[]] | undefined => {
  const a = tokens(before)
  const b = tokens(after)
  if (a.length * b.length > 40000 || a.length === 0 || b.length === 0) return undefined
  // lcs[i][j]: the common tokens of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const left: Piece[] = []
  const right: Piece[] = []
  const push = (out: Piece[], text: string, changed: boolean) => {
    const last = out.at(-1)
    if (last !== undefined && !!last.changed === changed) last.text += text
    else out.push(changed ? { text, changed: true } : { text })
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push(left, a[i]!, false); push(right, b[j]!, false); i++; j++ }
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) push(right, b[j++]!, true)
    else push(left, a[i++]!, true)
  }
  // How much of the two lines' text, spaces aside, is shared.
  const solid = (pieces: Piece[], changed: boolean) => pieces.filter(piece => !!piece.changed === changed).reduce((n, piece) => n + piece.text.replace(/\s/g, '').length, 0)
  const shared = solid(left, false) + solid(right, false)
  if (shared < 0.5 * (shared + solid(left, true) + solid(right, true))) return undefined

  return [left, right]
}

/**
 * Each removed line paired with the added line that replaced it: in a run of removed lines then added
 * ones, the first added line after the last pair that shares enough words with it.
 */
export const pairsOf = (lines: DiffLine[]): Map<number, number> => {
  const pairs = new Map<number, number>()
  for (let i = 0; i < lines.length;) {
    if (lines[i]?.sign !== '-') { i++; continue }
    const from = i
    while (lines[i]?.sign === '-') i++
    const to = i
    while (lines[i]?.sign === '+') i++
    let next = to
    for (let k = from; k < to && next < i; k++) {
      // A few lines ahead at most: a replacement sits near what it replaced.
      for (let j = next; j < Math.min(i, next + 8); j++) {
        if (wordDiff(lines[k]?.text ?? '', lines[j]?.text ?? '') === undefined) continue
        pairs.set(k, j)
        next = j + 1
        break
      }
    }
  }

  return pairs
}
