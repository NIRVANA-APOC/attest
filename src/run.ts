import { execaSync } from 'execa'

export type Ran = { code: number; out: string; err: string }
export type RunOptions = { cwd?: string; input?: string; inherit?: boolean; env?: NodeJS.ProcessEnv }
export type Run = (command: string, args: string[], options?: RunOptions) => Ran

/**
 * One command, run to completion. execa's sync API, with rejection off so a
 * failing command is data (`code`), the last newline kept so output is byte for
 * byte what the command wrote, and a spawn failure reported where spawnSync
 * reported it: the error text, on `err`, with code 1.
 */
export const run: Run = (command, args, options = {}) => {
  const child = execaSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    // spawnSync's contract: an env runs the child with exactly those variables, none of its own added.
    extendEnv: false,
    input: options.input,
    encoding: 'utf8',
    // `inherit` hands the terminal to the child (a tmux attach); output is then not captured.
    ...(options.inherit ? { stdio: 'inherit' as const } : { stdio: 'pipe' as const }),
    stripFinalNewline: false,
    maxBuffer: 16 * 1024 * 1024,
    reject: false,
  })

  return {
    code: child.exitCode ?? 1,
    out: child.stdout ?? '',
    err: child.exitCode === undefined && child.failed ? child.originalMessage ?? child.message ?? '' : child.stderr ?? '',
  }
}

/**
 * All CLI tmux calls, including live-state reads, go through this helper. `-u` keeps tmux from
 * replacing tabs and non-ASCII with `_` in format output when the caller's locale is not UTF-8.
 */
export const tmux = (args: string[], runner: Run = run, env = process.env, options: RunOptions = {}): Ran =>
  runner('tmux', ['-u', ...(env.ATTEST_TMUX_SOCKET ? ['-L', env.ATTEST_TMUX_SOCKET] : []), ...args], { ...options, env })

/** Each element stays one shell word, including quotes, newlines and dollars. */
export const shellOf = (argv: string[]): string => argv.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')
