// The YAML the plan, adapter, stage and result formats use: one document read
// with the `yaml` package, returned as plain data (mappings, lists, strings,
// null). Anything it cannot read is refused with its line, never misread.

import { parseDocument } from 'yaml'

export type Yaml = string | null | Yaml[] | { [key: string]: Yaml }

class YamlError extends Error {
  readonly line: number
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`)
    this.line = line
  }
}

/** Limits that keep a hostile document from exhausting memory or the call stack. */
const MAX_LENGTH = 1024 * 1024
const MAX_DEPTH = 64
const MAX_NODES = 100_000
/** Aliases are shared, so one document can expand to far more than it reads; the package caps that at 100. */
const MAX_ALIASES = 100

/** The last line that holds text: an error found at the end of the source points at it. */
const lastContentLine = (lines: string[]): number => {
  for (let index = lines.length - 1; index >= 0; index -= 1) if ((lines[index] ?? '').trim() !== '') return index + 1

  return 1
}

/**
 * The line a parse error points at, clamped to the last line with text: the
 * package reports end-of-input errors one line past the source.
 */
const lineOfError = (lines: string[], source: string, position: number | [number, number] | undefined): number => {
  const last = lastContentLine(lines)
  if (position === undefined) return last
  const at = typeof position === 'number' ? position : position[0]
  if (at >= source.length) return last

  return Math.max(1, Math.min(source.slice(0, at).split('\n').length, last))
}

/** Scalars keep their written text (a plan's `attest: 1` is "1"), so callers keep one value type. */
const plain = (value: unknown, depth: number, budget: { nodes: number }, line: number): Yaml => {
  if (depth > MAX_DEPTH) throw new YamlError(line, `the yaml nests deeper than ${MAX_DEPTH} levels`)
  budget.nodes += 1
  if (budget.nodes > MAX_NODES) throw new YamlError(line, `the yaml holds more than ${MAX_NODES} values`)
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(one => plain(one, depth + 1, budget, line))
  if (typeof value === 'object') {
    const out: { [key: string]: Yaml } = {}
    for (const [key, one] of Object.entries(value as { [key: string]: unknown })) out[key] = plain(one, depth + 1, budget, line)

    return out
  }

  return String(value)
}

export const parseYaml = (source: string, firstLine = 1): Yaml => {
  if (source.length > MAX_LENGTH) throw new YamlError(firstLine, `the yaml is longer than ${MAX_LENGTH} characters`)
  const lines = source.split('\n')
  const line = firstLine + lastContentLine(lines) - 1
  let document: ReturnType<typeof parseDocument>
  try {
    document = parseDocument(source, { prettyErrors: false, uniqueKeys: true })
  } catch (failure) {
    throw new YamlError(firstLine, failure instanceof Error ? failure.message : String(failure))
  }
  const error = document.errors[0]
  if (error !== undefined) throw new YamlError(firstLine + lineOfError(lines, source, error.pos) - 1, error.message)
  let data: unknown
  try {
    data = document.toJS({ maxAliasCount: MAX_ALIASES })
  } catch (failure) {
    // A document deep enough to exhaust the stack is still a document this format refuses, not a crash.
    const message = failure instanceof Error ? failure.message : String(failure)
    throw new YamlError(line, /call stack/i.test(message) ? `the yaml nests deeper than ${MAX_DEPTH} levels` : message)
  }

  return plain(data, 0, { nodes: 0 }, line)
}
