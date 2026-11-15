// Optional HTTP provider for a Jev-compatible decision endpoint. It is off by
// default: `provider: heuristic` needs no network. When configured, it posts
// the typed-question protocol (state + narrow questions) with a bearer key,
// validates the response with zod, caps the untrusted state at 32,000
// characters with an explicit truncation marker, and retries an idempotent
// call with p-retry.
//
// On any failure it throws a typed `TypeSafeError`; the policy falls back to
// the heuristic provider and records the error in the outcome. The key is
// never logged: every error message is sanitised before it leaves this module.
import pRetry from 'p-retry'
import { z } from 'zod'

import { canonicalJson, digestOf } from './ledger.ts'
import type { JevAnswer, JevInput, JevProvider, JevQuestion, JevQuestions } from './types.ts'

export const TYPESAFE_ID = 'typesafe'
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
export const DEFAULT_MODEL = 'jev-latest'
export const DEFAULT_TIMEOUT_MS = 8000
/** The published Jev state ceiling: longer states are truncated, never sent whole. */
export const MAX_STATE_CHARS = 32000
export const TRUNCATION_MARKER = '\n[attest: state truncated at 32000 characters; the rest was not sent]'

export type TypeSafeErrorKind = 'config' | 'http' | 'timeout' | 'network' | 'malformed'

export class TypeSafeError extends Error {
  readonly kind: TypeSafeErrorKind
  readonly status: number | undefined
  readonly retryable: boolean
  constructor(kind: TypeSafeErrorKind, message: string, status?: number, retryable = false) {
    super(message)
    this.name = 'TypeSafeError'
    this.kind = kind
    this.status = status
    this.retryable = retryable
  }
}

export type TypeSafeOptions = {
  baseUrl?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
  /** Extra attempts after the first call; the default retries twice. */
  retries?: number
  /** Base backoff delay; tests shrink it. */
  retryDelayMs?: number
  env?: NodeJS.ProcessEnv
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

const integerOf = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

type Resolved = { baseUrl: string; apiKey: string; model: string; timeoutMs: number; retries: number; retryDelayMs: number; env: NodeJS.ProcessEnv; fetchImpl: (url: string, init: RequestInit) => Promise<Response> }

const resolve = (options: TypeSafeOptions): Resolved => {
  const env = options.env ?? process.env

  return {
    baseUrl: (options.baseUrl ?? env.ATTEST_JEV_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: options.apiKey ?? env.ATTEST_JEV_API_KEY ?? '',
    model: options.model ?? env.ATTEST_JEV_MODEL ?? DEFAULT_MODEL,
    timeoutMs: options.timeoutMs ?? integerOf(env.ATTEST_JEV_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? 2,
    retryDelayMs: options.retryDelayMs ?? 250,
    env,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
  }
}

/** Whether a key is configured; the provider itself is always constructible. */
export const typeSafeConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => (env.ATTEST_JEV_API_KEY ?? '').trim() !== ''

const sanitize = (text: string, apiKey: string): string => {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('[redacted]')

  return withoutKey.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300)
}

const QUESTION_PREFIX = '<attest-state untrusted="true">\n'
const QUESTION_SUFFIX = '\n</attest-state>'

/** The state as sent: untrusted data, explicitly delimited, capped at 32,000 characters. */
export const cappedState = (state: string | Record<string, unknown>): { state: string; truncated: boolean; originalChars: number } => {
  const raw = typeof state === 'string' ? state : canonicalJson(state)
  const budget = MAX_STATE_CHARS - QUESTION_PREFIX.length - QUESTION_SUFFIX.length
  if (raw.length <= budget) return { state: `${QUESTION_PREFIX}${raw}${QUESTION_SUFFIX}`, truncated: false, originalChars: raw.length }
  const keep = Math.max(0, budget - TRUNCATION_MARKER.length)

  return { state: `${QUESTION_PREFIX}${raw.slice(0, keep)}${TRUNCATION_MARKER}${QUESTION_SUFFIX}`, truncated: true, originalChars: raw.length }
}

// The published System One response: one answer per question id, discriminated
// by `type`; noul answers carry `noul` (no confidence), score answers carry an
// interpolated `score` plus legend, choice answers carry the chosen option and
// its probability distribution.
const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) })
const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  confidence: z.number().min(0).max(1).optional(),
})
const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  confidence: z.number().min(0).max(1).optional(),
})
const AnswerSchema = z.discriminatedUnion('type', [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema])

const ResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
})

/** The published request: one state, a model, and a map of typed questions. */
const instructionText = (question: JevQuestion): string | string[] => {
  const parts = [question.question, question.instructions].filter((one): one is string => typeof one === 'string' && one.trim() !== '')

  return parts.length === 1 ? parts[0] ?? '' : parts
}

const defaultCriteria = (levels: number): string[] =>
  Array.from({ length: levels }, (_, index) => `level ${index + 1}${index === 0 ? ' (lowest risk)' : index === levels - 1 ? ' (highest risk)' : ''}`)

const wireQuestion = (question: JevQuestion): Record<string, unknown> => {
  if (question.kind === 'noul') return { type: 'noul', instructions: instructionText(question) }
  if (question.kind === 'choice') {
    return { type: 'choice', instructions: instructionText(question), criteria: Object.fromEntries(question.options.map(option => [option, null])) }
  }

  return { type: 'score', instructions: instructionText(question), criteria: question.criteria ?? defaultCriteria(question.levels) }
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Score levels are ordered low to high risk by their criteria; normalize to 0..1. */
const scoreRisk = (answer: z.infer<typeof ScoreAnswerSchema>, question: Extract<JevQuestion, { kind: 'score' }>): number => {
  const levels = answer.legend === undefined ? Array.from({ length: question.levels }, (_, index) => index) : Object.keys(answer.legend).map(Number).filter(Number.isFinite)
  const low = Math.min(...levels)
  const high = Math.max(...levels)
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return clamp01(answer.score / Math.max(1, question.levels - 1))

  return clamp01((answer.score - low) / (high - low))
}

/** Checks a parsed response against the questions that were asked; throws a malformed error. */
const answersOf = (parsed: z.infer<typeof ResponseSchema>, questions: JevQuestions): Record<string, JevAnswer> => {
  const answers: Record<string, JevAnswer> = {}
  for (const [key, question] of Object.entries(questions)) {
    const answer = parsed.answers[key]
    if (answer === undefined) throw new TypeSafeError('malformed', `response has no answer for question "${key}"`)
    if (answer.type !== question.kind) throw new TypeSafeError('malformed', `answer "${key}" is a ${answer.type}, the question is a ${question.kind}`)
    if (answer.type === 'noul') {
      answers[key] = { kind: 'noul', probability: answer.noul }
    } else if (answer.type === 'score') {
      const score = { ...answer } as Extract<typeof answer, { type: 'score' }>
      answers[key] = { kind: 'score', probability: scoreRisk(score, question as Extract<JevQuestion, { kind: 'score' }>), ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) }
    } else {
      if (question.kind !== 'choice') throw new TypeSafeError('malformed', `answer "${key}" is not one of the question's options`)
      if (!question.options.includes(answer.choice)) throw new TypeSafeError('malformed', `answer "${key}" is not one of the question's options`)
      const probability = answer.probabilities?.[answer.choice]

      answers[key] = { kind: 'choice', choice: answer.choice, ...(probability === undefined ? {} : { probability }), ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) }
    }
  }

  return answers
}

const requestBody = (model: string, input: JevInput): string => {
  const capped = cappedState(input.state)
  const questions = Object.fromEntries(Object.entries(input.questions).map(([key, question]) => [key, wireQuestion(question)]))

  return JSON.stringify({ model, state: capped.state, questions })
}

/**
 * The HTTP decision provider. Construction reads configuration only; a missing
 * key throws a `config` error on the first call, which the policy records and
 * falls back from. No call is made without a key.
 */
export const typeSafeProvider = (options: TypeSafeOptions = {}): JevProvider => ({
  id: TYPESAFE_ID,
  decide: async (input: JevInput, limits?: { timeoutMs?: number }) => {
    const config = resolve(options)
    if (config.apiKey.trim() === '') throw new TypeSafeError('config', 'ATTEST_JEV_API_KEY is not set; the typesafe provider is optional and the heuristic stays the default')
    const timeoutMs = limits?.timeoutMs ?? config.timeoutMs
    const started = Date.now()
    const endpoint = /\/v1\/systemone$/.test(config.baseUrl) ? config.baseUrl : /\/v1$/.test(config.baseUrl) ? `${config.baseUrl}/systemone` : `${config.baseUrl}/v1/systemone`
    const body = requestBody(config.model, input)
    const attempt = async (): Promise<{ answers: Record<string, JevAnswer>; model: string; usage?: { inputTokens?: number; outputTokens?: number } }> => {
      let response: Response
      try {
        response = await config.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${config.apiKey}`, 'user-agent': 'attest/0.1.0' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        if (name === 'AbortError' || name === 'TimeoutError') throw new TypeSafeError('timeout', `decision request timed out after ${timeoutMs} ms`, undefined, true)
        throw new TypeSafeError('network', `decision request failed: ${sanitize(error instanceof Error ? error.message : String(error), config.apiKey)}`, undefined, true)
      }
      if (!response.ok) {
        let detail = ''
        try {
          detail = sanitize(await response.text(), config.apiKey)
        } catch {
          detail = ''
        }
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        throw new TypeSafeError('http', `decision endpoint answered ${response.status}${detail === '' ? '' : `: ${detail}`}`, response.status, retryable)
      }
      let parsed: z.infer<typeof ResponseSchema>
      try {
        parsed = ResponseSchema.parse(await response.json())
      } catch (error) {
        if (error instanceof TypeSafeError) throw error
        const issues = error instanceof z.ZodError ? error.issues.map(issue => issue.path.join('.') || '(root)').slice(0, 3).join(', ') : 'not JSON'
        throw new TypeSafeError('malformed', `decision response did not match the typed protocol: ${issues}`)
      }

      const usage = parsed.usage === undefined ? undefined : {
        ...(parsed.usage.input_tokens === undefined ? {} : { inputTokens: parsed.usage.input_tokens }),
        ...(parsed.usage.output_tokens === undefined ? {} : { outputTokens: parsed.usage.output_tokens }),
      }

      return { answers: answersOf(parsed, input.questions), model: parsed.model ?? config.model, ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }) }
    }
    let result: { answers: Record<string, JevAnswer>; model: string; usage?: { inputTokens?: number; outputTokens?: number } }
    try {
      result = await pRetry(attempt, {
        retries: config.retries,
        minTimeout: config.retryDelayMs,
        maxTimeout: config.retryDelayMs * 2,
        factor: 2,
        randomize: false,
        shouldRetry: error => error instanceof TypeSafeError && error.retryable,
      })
    } catch (error) {
      if (error instanceof TypeSafeError) throw new TypeSafeError(error.kind, sanitize(error.message, config.apiKey), error.status, false)
      throw new TypeSafeError('network', `decision request failed: ${sanitize(error instanceof Error ? error.message : String(error), config.apiKey)}`)
    }
    if (result.answers === undefined) throw new TypeSafeError('malformed', 'decision response carried no answers')

    return {
      id: input.id,
      at: new Date().toISOString(),
      provider: TYPESAFE_ID,
      model: result.model,
      stateDigest: input.stateDigest ?? digestOf(input.state),
      answers: result.answers,
      latencyMs: Math.max(0, Date.now() - started),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }
  },
})
