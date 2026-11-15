import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { execaSync } from 'execa'
import { z } from 'zod'

/** Where a Claude role's status line leaves the context window Claude Code reports. */
export const CONTEXT_FILE = '.attest/context.json'

/**
 * The two documents this module reads: Claude Code's status line payload (external) and the context file this
 * module writes (`attest statusline`). Both are untrusted on disk, so a malformed one only means "unknown".
 */
const PAYLOAD = z.object({
  session_id: z.string(),
  context_window: z.object({ context_window_size: z.number() }),
}).loose()
const CONTEXT = z.object({ session: z.string(), window: z.number().int().positive() })

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The status line command Claude Code would run for a session in `root`: local, then project, then user settings. */
export const statusLineCommand = (root: string, home: string): string | undefined => {
  for (const path of [join(root, '.claude/settings.local.json'), join(root, '.claude/settings.json'), join(home, '.claude/settings.json')]) {
    const settings = z.object({ statusLine: z.object({ type: z.unknown(), command: z.unknown() }).loose() }).loose().safeParse(readJson(path))
    if (!settings.success) continue
    const { type, command } = settings.data.statusLine

    return type === 'command' && typeof command === 'string' && command.trim() !== '' ? command : undefined
  }

  return undefined
}

/** Claude Code has no window field in its transcript; its status line payload has the real one. */
export const contextWindowOf = (worktree: string, session: string): number | undefined => {
  const saved = CONTEXT.safeParse(readJson(join(worktree, CONTEXT_FILE)))

  return saved.success && saved.data.session === session ? saved.data.window : undefined
}

/** `attest statusline <file> [command]`: keep the payload's window for the panel, then show the person's own status line. */
export const statusLine = (input: string, file: string, forward?: string): string => {
  try {
    const payload = PAYLOAD.safeParse(JSON.parse(input))
    if (payload.success) {
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify({ session: payload.data.session_id, window: payload.data.context_window.context_window_size })}\n`)
      renameSync(temp, file)
    }
  } catch { /* A status line must never fail the session; the panel falls back to its guess. */ }
  if (forward === undefined || forward === '') return ''
  const shown = execaSync('/bin/sh', ['-c', forward], { input, encoding: 'utf8', stripFinalNewline: false, timeout: 5000, reject: false })

  return shown.stdout ?? ''
}
