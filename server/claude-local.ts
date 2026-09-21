// Claude Code as the model behind meeting write-ups, when Alfredo runs on a
// Mac that has it. Nothing here touches Claude's network: it is the same
// `claude -p` a person would run, with the prompt on stdin and the answer as
// JSON on stdout. The hosted model on the public site stays as it was.

import { jsonrepair } from 'jsonrepair'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { workspaceFolder } from './home'
import { WINDOWS, onPath, runAsUser } from './platform'

const MODEL = process.env.ALFRED_LOCAL_MODEL ?? 'claude-sonnet-5'

let known: boolean | null = null
/** Is `claude` on PATH, as a terminal would see it? Checked once. */
export async function claudeAvailable(): Promise<boolean> {
  if (known !== null) return known
  known = await onPath('claude')
  return known
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/.test(k)))
}

export type LocalAnswer = { text: string; cost: number; model: string }

/**
 * One prompt in, one answer out. With a schema the model is told to answer
 * with only a JSON object, and the JSON is cut out of whatever it wrote
 * around it.
 */
export async function claudeChat(prompt: string, schema?: object, maxTokens?: number): Promise<LocalAnswer> {
  const full = schema
    ? `${prompt}\n\nAnswer with ONLY a JSON object that matches this JSON Schema, no prose and no code fence:\n${JSON.stringify(schema)}`
    : prompt
  const args = ['-p', '--output-format', 'json', '--model', MODEL, '--allowedTools', '', '--permission-mode', 'default']
  const cwd = workspaceFolder()
  const out = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const quote = (a: string) => (WINDOWS ? (a === '' ? '""' : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a) : `'${a}'`)
    const p = runAsUser(`claude ${args.map(quote).join(' ')}`, { cwd, env: cleanEnv() })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    const t = setTimeout(() => p.kill(), 6 * 60_000)
    p.on('exit', (code) => {
      clearTimeout(t)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
    p.on('error', (e) => {
      clearTimeout(t)
      resolve({ stdout: '', stderr: String(e), code: 1 })
    })
    p.stdin.end(full)
  })
  if (out.code !== 0 && !out.stdout.trim()) throw new Error(`claude exited ${out.code}: ${out.stderr.trim().slice(-400)}`)

  // `--output-format json` prints one object; some builds print a line before it.
  const start = out.stdout.indexOf('{')
  let envelope: any = null
  try {
    envelope = JSON.parse(out.stdout.slice(start))
  } catch {
    throw new Error(`claude returned something that was not JSON: ${out.stdout.slice(0, 200)}`)
  }
  if (envelope.is_error) throw new Error(String(envelope.result ?? 'claude reported an error'))
  let text = String(envelope.result ?? '')
  const cost = Number(envelope.total_cost_usd ?? 0)
  if (schema) {
    // Cut the object out of the reply, fence or no fence.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
    const body = fenced ? fenced[1] : text
    const a = body.indexOf('{')
    const b = body.lastIndexOf('}')
    if (a < 0 || b < a) throw new Error('claude did not answer with JSON')
    text = body.slice(a, b + 1)
    // Quotes copied out of a transcript are where hand-written JSON breaks:
    // an unescaped quote, a stray newline. Repair before giving up.
    try {
      JSON.parse(text)
    } catch {
      text = jsonrepair(text)
      JSON.parse(text)
    }
  }
  void maxTokens
  return { text, cost, model: `claude-code/${MODEL}` }
}
