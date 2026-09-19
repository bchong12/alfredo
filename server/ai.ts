// Transcription and extraction, both through OpenRouter. One key, and the
// models are env vars rather than code, so swapping is a config change.
//
// Nothing here touches a Node built-in, on purpose: this module has to run
// unchanged on Deno inside a Supabase Edge Function. The ffmpeg-backed local
// recording path lives in ai-local.ts for exactly that reason.

import { env } from './env'

const URL = 'https://openrouter.ai/api/v1/chat/completions'

// Cheapest audio-capable model with real quality: ~$0.016 per hour of meeting.
export const TRANSCRIBE_MODEL = env('CRM_TRANSCRIBE_MODEL') ?? 'google/gemini-2.5-flash-lite'
/*
 * Extraction runs on Flash, not on the cheapest model available. gpt-oss-120b
 * took 43s to this model's 4.5s on the same transcript, and under the richer
 * schema it started returning action items with empty titles. Ten times the
 * price of nothing is still nothing (about $0.007 a meeting), and 43s is
 * uncomfortably close to the 150s an Edge Function is allowed to run.
 */
const EXTRACT_MODEL = env('CRM_EXTRACT_MODEL') ?? 'google/gemini-2.5-flash'

export const BITRATE_KBPS = 32

type Content =
  | { type: 'text'; text: string }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }

/**
 * A 20-minute audio chunk can legitimately take minutes. Without a ceiling a
 * wedged provider hangs the MCP tool forever, with no way to tell a slow
 * transcription from a dead one.
 */
const REQUEST_TIMEOUT_MS = Number(env('CRM_REQUEST_TIMEOUT_MS') ?? 8 * 60 * 1000)

/** What one model call cost, in US dollars, as billed rather than estimated. */
export type Spend = { cost: number; tokens: number }

/**
 * `apiKey` is the caller's own OpenRouter key, resolved per user rather than
 * read from the environment. See keys.ts for why there is no shared fallback.
 */
/**
 * A model on this machine, installed by the Node entry when Claude Code is
 * present. Text-only prompts (write-ups, questions) go there and need no
 * key; audio still goes to the hosted model unless Parakeet has it.
 */
export type LocalChat = (prompt: string, schema?: object, maxTokens?: number) => Promise<{ text: string; cost: number; model: string }>
let localChat: LocalChat | null = null
export function setLocalChat(fn: LocalChat | null) {
  localChat = fn
}
export const hasLocalChat = () => localChat !== null
/** What to record as the model behind a write-up. */
const extractModelName = () => (localChat ? 'claude-code (local)' : EXTRACT_MODEL)

export async function chat(
  apiKey: string,
  model: string,
  content: Content[] | string,
  schema?: object,
  spend?: Spend[],
  maxTokens?: number,
) {
  if (localChat && typeof content === 'string') {
    const r = await localChat(content, schema, maxTokens)
    spend?.push({ cost: r.cost, tokens: 0 })
    return r.text
  }
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content }],
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    // Transcription must not paraphrase, and extraction must not embellish.
    temperature: 0,
    // Asks the provider to price the call and hand back what it actually
    // charged, so a meeting's cost is recorded rather than guessed at from a
    // rate card that changes without notice.
    usage: { include: true },
  }
  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'meeting_summary', strict: true, schema },
    }
    // Support is per endpoint, not per model: the same model served by a
    // provider without json_schema would silently return prose instead.
    body.provider = { require_parameters: true }
  }

  const abort = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  let r: Response
  try {
    r = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'alfredo',
      },
      body: JSON.stringify(body),
      signal: abort,
    })
  } catch (e) {
    if (abort.aborted) {
      throw new Error(
        `openrouter ${model} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. ` +
          `The audio is saved, so retry with transcribe_meeting rather than re-recording.`,
      )
    }
    throw e
  }
  if (!r.ok) throw new Error(`openrouter ${model} failed (${r.status}): ${await r.text()}`)

  const json = (await r.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { cost?: number; total_tokens?: number }
    error?: { message?: string }
  }
  // OpenRouter can return a 200 whose body carries a provider-side error.
  if (json.error) throw new Error(`openrouter ${model}: ${json.error.message}`)

  const text = json.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error(`openrouter ${model} returned no content`)
  spend?.push({ cost: json.usage?.cost ?? 0, tokens: json.usage?.total_tokens ?? 0 })
  return text
}

/**
 * Names the model has never heard get mangled into ordinary words — "Tauri"
 * came back as "tory" and then poisoned the summary and the decision list.
 * Seeding the spellings costs nothing and fixes it at the source.
 */
/**
 * Who the meeting belongs to. Callers pass the workspace (its name and its
 * people); CRM_TEAM is only the fallback for a deployment with no workspace.
 */
const TEAM = env('CRM_TEAM') ?? 'a small team'

/** "Acme. The people in it: Ana, Ben" — the context a write-up needs. */
export const teamContext = (name: string | undefined, people: string[]) =>
  `${name?.trim() || 'a small team'}${people.length ? `. The people in it: ${people.join(', ')}` : ''}`

const VOCABULARY =
  env('CRM_VOCABULARY') ?? 'MCP, Supabase, Cloudflare, Svelte, Claude'

export const TRANSCRIBE_PROMPT = `Produce a verbatim transcript of this meeting recording.

Rules:
- Label each turn with a speaker as "Speaker 1:", "Speaker 2:", and so on. If a
  speaker states their own name, use that name from then on.
- Start a new line for each turn.
- Do not summarize, do not skip filler, do not clean up grammar.
- If a passage is inaudible write [inaudible] rather than guessing.
- Output the transcript only, with no preamble and no closing commentary.

These proper nouns and terms come up in this team's meetings. When you hear
something close to one of them, spell it this way rather than substituting an
ordinary word that sounds similar:
${VOCABULARY}`

/**
 * Node's `Buffer` is not a global in the Edge runtime, so a `.toString('base64')`
 * here cost a real 27-minute meeting: it threw only in production, after the
 * audio had already uploaded. `btoa` exists in both. It takes a binary string,
 * and spreading a whole 5MB file into String.fromCharCode blows the argument
 * limit, hence the chunking.
 */
export function toBase64(bytes: Uint8Array) {
  const SIZE = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SIZE))
  }
  return btoa(binary)
}

/**
 * Audio transcribers fall into repetition loops, and the output is confident
 * rather than obviously broken. Two real cases from this workspace:
 *
 *  - A 20-minute segment transcribed fourteen turns and then cycled a block of
 *    long lines: 281,593 characters, 290 lines, 15 distinct.
 *  - A 4-minute segment of a phone call taken mid-meeting cycled short
 *    fragments ("Oh, how?", "Yeah.") instead: 161,802 characters, 6,111 lines,
 *    26 distinct. That one is 71% of a 74-minute meeting's entire transcript.
 *
 * The first version of this looked for a long line repeating and so missed the
 * second case entirely. Line length is the wrong signal. What both share is a
 * global property no real transcript has: thousands of lines drawn from a
 * couple of dozen distinct ones.
 *
 * So detection is global and the cut is local. Deciding "this ran away" from
 * the whole text means a couple of genuinely repeated exchanges can never
 * trigger it; only once that is established do we look for where the cycle
 * starts.
 */
const LOOP_MIN_LINES = 60
const LOOP_MAX_DISTINCT = 0.5
/** Consecutive lines that must recur verbatim to mark the top of a cycle. */
const CYCLE_WINDOW = 6

export function cutRepetitionLoop(text: string) {
  const lines = text.split('\n')
  const solid = lines.map((l) => l.trim().toLowerCase()).filter(Boolean)
  if (solid.length < LOOP_MIN_LINES) return { text, looped: false }
  if (new Set(solid).size / solid.length > LOOP_MAX_DISTINCT) return { text, looped: false }

  // It ran away. Find the first stretch that repeats something already said.
  const seen = new Set<string>()
  for (let i = 0; i + CYCLE_WINDOW <= lines.length; i++) {
    const key = lines.slice(i, i + CYCLE_WINDOW).join('\n').trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) return { text: lines.slice(0, i).join('\n').trim(), looped: true }
    seen.add(key)
  }
  // Degenerate but with no clean cycle boundary. Keeping all of it would drown
  // the summariser, so keep the opening and admit the rest is gone.
  return { text: lines.slice(0, LOOP_MIN_LINES).join('\n').trim(), looped: true }
}

/*
 * A five-minute segment of speech is about 1,300 tokens of transcript. The cap
 * is far above that and exists only to bound a runaway: the phone-call segment
 * that looped produced ten times its neighbours' output and cost ten times as
 * much before stopping on its own.
 */
const TRANSCRIBE_MAX_TOKENS = 8000

export function transcribeChunk(
  apiKey: string,
  data: string,
  format: string,
  hint: string,
  spend?: Spend[],
) {
  return chat(
    apiKey,
    TRANSCRIBE_MODEL,
    [
      { type: 'text', text: TRANSCRIBE_PROMPT + hint },
      { type: 'input_audio', input_audio: { data, format } },
    ],
    undefined,
    spend,
    TRANSCRIBE_MAX_TOKENS,
  )
}

/**
 * strict mode requires every property to appear in `required` and every object
 * to set additionalProperties:false, so logically-optional fields are
 * required-but-empty.
 *
 * The shape is deliberately adaptive. A fixed set of buckets forces every
 * meeting into the same mould, so a phone call and a design review come out
 * looking identical with half the headings empty. `sections` lets the model
 * choose headings that fit what was actually said. That is the single biggest
 * difference between a note that reads well and one that reads like a form.
 */
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description:
        'What the meeting was about, 3 to 6 words. Name the subject: "Export pipeline and ' +
        'pricing". Never a date and never the word "meeting" or "notes" on its own.',
    },
    tldr: {
      type: 'string',
      description:
        'Two or three sentences someone who missed this could read to know where things stand.',
    },
    sections: {
      type: 'array',
      description:
        'The body of the note: what was actually said and why it matters. Choose 2 to 5 headings ' +
        'that fit THIS meeting rather than reusing a template. Good headings name the subject: ' +
        '"Export pipeline", "Pricing". Weak headings are generic: "Discussion", "Notes".',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          heading: { type: 'string' },
          bullets: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Full sentences carrying the substance: what was found, what the state of things ' +
              'is, the reasoning, any numbers. Do NOT restate decisions, action items or open ' +
              'questions here; each has its own place in the note and repeating them makes it ' +
              'twice as long and half as useful. Never write "Decision: none" or "Action items:".',
          },
        },
        required: ['heading', 'bullets'],
      },
    },
    decisions: {
      type: 'array',
      description: 'Only questions that got SETTLED. "We should probably" is not a decision.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          what: { type: 'string', description: 'The decision, one line.' },
          why: {
            type: 'string',
            description:
              'The reason given in the conversation, in their terms, e.g. "not worth the risk ' +
              'before launch". "" if no reason was stated. Never meta-commentary like ' +
              '"Sam stated the decision" - that says nothing.',
          },
          quote: {
            type: 'string',
            description:
              'The line from the transcript that settles it, copied VERBATIM. It is checked ' +
              'against the transcript, so paraphrasing causes the decision to be dropped.',
          },
        },
        required: ['what', 'why', 'quote'],
      },
    },
    action_items: {
      type: 'array',
      description:
        'Everything a person committed to doing, including the small ones. A commitment is ' +
        'anyone saying they will do a thing: "I\'ll send you the resume", "I can put together ' +
        'the numbers", "let me look into that", and also a request that was accepted: ' +
        '"can you write that up?" answered with "yeah". Musing about an idea is not one, and ' +
        'neither is a thing that merely needs doing with nobody taking it. Err toward ' +
        'including a real commitment: a meeting where people talked for an hour and agreed to ' +
        'nothing is rare, and the whole point of this list is that these become tasks.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Imperative, one line.' },
          detail: { type: 'string', description: 'Context needed to act on it.' },
          assignee: { type: 'string', description: 'Name if stated, otherwise "".' },
          due_text: {
            type: 'string',
            description:
              'The deadline exactly as spoken, e.g. "by Friday". Do not convert it to a date. ' +
              '"" if no deadline was mentioned.',
          },
          quote: {
            type: 'string',
            description:
              'The line where the commitment was made, copied VERBATIM from the transcript, ' +
              'including any filler words in it. It is matched against the transcript and the ' +
              'item is DROPPED if it does not appear there, so copy rather than reconstruct. ' +
              'Prefer a short exact span over a long tidied one.',
          },
        },
        required: ['title', 'detail', 'assignee', 'due_text', 'quote'],
      },
    },
    open_questions: {
      type: 'array',
      description:
        'Raised but left unresolved: nobody answered, or it was explicitly parked. These are ' +
        'among the most useful things in a meeting note and the easiest to lose.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          why: { type: 'string', description: 'Why it matters, or what is blocked on it.' },
        },
        required: ['question', 'why'],
      },
    },
    participants: {
      type: 'array',
      items: { type: 'string' },
      description: 'Speakers identified by name. Empty if nobody was named.',
    },
    anchored: {
      type: 'array',
      description:
        'Only when the person gave you their own notes. For each line of theirs, say whether ' +
        'the transcript actually supported it. Empty array when no notes were given.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note: { type: 'string', description: 'Their line, copied as they wrote it.' },
          supported: {
            type: 'boolean',
            description:
              'True ONLY if the TRANSCRIPT contains discussion of this. Their own note is not ' +
              'evidence for itself: a line they wrote that nobody said out loud is false, ' +
              'however reasonable it looks.',
          },
        },
        required: ['note', 'supported'],
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      description:
        'How well the transcript actually supports this note. A confident summary built on ' +
        'garbled audio is worse than saying the audio was garbled.',
      properties: {
        quality: {
          type: 'string',
          enum: ['good', 'partial', 'poor'],
          description:
            'good: the conversation is clearly captured. partial: audible but with gaps, ' +
            'one-sided, or very short. poor: fragmented or largely unintelligible.',
        },
        note: {
          type: 'string',
          description:
            'One sentence on what is missing and what to do about it, e.g. "Only your side of ' +
            'the call was captured; check with Sam on what they committed to." "" when good.',
        },
      },
      required: ['quality', 'note'],
    },
  },
  required: [
    'title', 'tldr', 'sections', 'decisions', 'action_items',
    'open_questions', 'participants', 'coverage', 'anchored',
  ],
}
export type Section = { heading: string; bullets: string[] }
export type Decision = { what: string; why: string; quote: string }
export type OpenQuestion = { question: string; why: string }
export type Coverage = { quality: 'good' | 'partial' | 'poor'; note: string }
export type Anchor = { note: string; supported: boolean }

type RawAction = {
  title: string
  detail: string
  assignee: string
  due_text: string
  quote: string
}

type RawSummary = {
  title: string
  tldr: string
  sections: Section[]
  decisions: Decision[]
  action_items: RawAction[]
  open_questions: OpenQuestion[]
  participants: string[]
  coverage: Coverage
  anchored: Anchor[]
}

export type Summary = Omit<RawSummary, 'action_items'> & {
  action_items: (RawAction & {
    /** Resolved here, not by the model. "" when the phrase did not parse. */
    due: string
  })[]
  /** Claims whose quote could not be found in the transcript. */
  unverified: number
}

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
]

/**
 * Turn a spoken deadline into a date. Deliberately not the model's job: asked
 * to resolve "by Friday" it returned a Saturday, and a due date that is quietly
 * wrong is worse than one that is quietly missing.
 *
 * Returns "" for anything it cannot resolve confidently. due_text keeps the
 * original either way, so nothing is lost.
 */
export function resolveDue(text: string, today = new Date()): string {
  const t = text.toLowerCase().trim()
  if (!t) return ''

  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return iso[1]

  const day = (d: Date) => d.toISOString().slice(0, 10)
  const plus = (n: number) => {
    const d = new Date(today)
    d.setDate(d.getDate() + n)
    return day(d)
  }

  if (/\btoday\b/.test(t)) return day(today)
  if (/\btomorrow\b/.test(t)) return plus(1)

  const inDays = t.match(/\bin (\d+) days?\b/)
  if (inDays) return plus(Number(inDays[1]))

  const inWeeks = t.match(/\bin (\d+) weeks?\b/)
  if (inWeeks) return plus(Number(inWeeks[1]) * 7)

  // A named weekday means the next one strictly ahead of today. "next Friday"
  // when today is Friday means a week out, not this morning.
  const named = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t))
  if (named >= 0) {
    let delta = (named - today.getDay() + 7) % 7
    if (delta === 0) delta = 7
    if (/\bnext\b/.test(t) && delta < 7) delta += 7
    return plus(delta)
  }

  if (/\bend of (the )?week\b/.test(t)) {
    const delta = (5 - today.getDay() + 7) % 7 // Friday
    return plus(delta === 0 ? 7 : delta)
  }
  if (/\bend of next week\b/.test(t)) {
    // Friday of next week, not "seven days from now".
    const toFri = (5 - today.getDay() + 7) % 7
    return plus((toFri === 0 ? 7 : toFri) + 7)
  }
  if (/\bnext week\b/.test(t)) return plus(7)
  if (/\bend of (the )?month\b/.test(t)) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    return day(d)
  }

  return ''
}

/** Models reach for typographic dashes; keep stored copy plain ASCII. */
function plain<T>(v: T): T {
  if (typeof v === 'string') {
    return v.replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\u00a0/g, ' ') as unknown as T
  }
  if (Array.isArray(v)) return v.map(plain) as unknown as T
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]),
    ) as T
  }
  return v
}

/**
 * Normalise for quote matching: models reproduce a line faithfully but drift on
 * punctuation, casing and whitespace. Comparing on those would reject quotes
 * that are, in substance, exact.
 */
const forMatch = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

const STOP = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'would',
  'could', 'should', 'because', 'before', 'other', 'thing', 'really', 'still',
  'where', 'while', 'with', 'that', 'this', 'from', 'have', 'been', 'were',
])

/**
 * A conservative second opinion on whether the transcript really covers one of
 * their note lines. It can only downgrade the model's answer, never promote it.
 *
 * Shorthand does not appear verbatim ("border radius - blocking?" against "border
 * radius gets dropped"), so this asks a weaker question: does any distinctive
 * word from the line occur in the transcript at all? A line about Figma in a
 * meeting that never says Figma fails that, which is the case worth catching.
 */
function noteIsCovered(note: string, haystack: string) {
  const words = note
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w))
  if (!words.length) return true
  return words.some((w) => haystack.includes(w))
}

/**
 * Every decision and action item has to cite the line that supports it, and
 * the citation is checked against the transcript here.
 *
 * This is the point of the quotes. A model asked for decisions will invent
 * plausible ones; a model asked to also produce the exact line it came from
 * has to have actually seen it, and when it does invent one we can tell,
 * because the line will not be in the transcript. Dropping those is how a note
 * earns being trusted without reading the transcript to check it.
 */
function verify<T extends { quote: string }>(items: T[], haystack: string) {
  const kept: T[] = []
  let dropped = 0
  for (const item of items) {
    const q = forMatch(item.quote ?? '')
    // Very short quotes match by accident, so they are not evidence of anything.
    if (q.length >= 12 && haystack.includes(q)) kept.push(item)
    else dropped++
  }
  return { kept, dropped }
}

export async function summarize(
  apiKey: string,
  transcript: string,
  /**
   * What the person typed during the meeting. When present this stops being a
   * summarisation job and becomes an expansion job: their fragments are the
   * outline, and the transcript is the source they get filled in from. It is
   * the difference between a note that sounds like the meeting and a note that
   * sounds like the person who was in it.
   */
  rawNotes?: string,
  spend?: Spend[],
  /** Whose meeting this is (see teamContext). */
  team: string = TEAM,
): Promise<Summary & { model: string }> {
  // Without this the model cannot resolve "by Friday" and drops the due date
  // entirely rather than guessing, so a deadline said out loud disappears.
  const today = new Date()
  const dateLine = `Today is ${today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })} (${today.toISOString().slice(0, 10)}).`

  const notes = rawNotes?.trim()

  const withNotes = notes
    ? `
THE PERSON TOOK THESE NOTES DURING THE MEETING. They are the outline of what
mattered to them, written fast and half-finished:

${notes}

Work from those, not from scratch:
- Their lines set the sections and the order. Keep their framing and their
  words where they wrote them; you are filling in around their shorthand, not
  replacing it with your own summary.
- Expand each line using the transcript: what was actually said about it, the
  numbers, who said what. A line like "border radius bug - blocking?" should
  become the finding and its answer.
- If a line has nothing behind it in the transcript, keep it in \`anchored\`
  marked unsupported and STOP THERE. Do not give it a section, a bullet, a
  decision or an action item. Their note is not evidence that a thing was
  discussed; only the transcript is.
    Their note: "ask sam about the csv importer"
    Transcript: never mentions Figma.
    Right: anchored entry, supported false. Nothing else anywhere in the note.
    Wrong: a "Figma importer" section saying it was raised as a topic.
- Add sections only for things clearly discussed that they missed entirely.
  They wrote down what mattered to them; extra sections are for genuine gaps,
  not for padding.
- Fill \`anchored\` with one entry per line of theirs.
`
    : ''

  const prompt = `You are writing the meeting note for ${team}. The note is read
by whoever missed the meeting, and its action items become cards on a board, so
being wrong is worse than being brief.

${dateLine}
${withNotes}
How to write it:

- Pick section headings that fit THIS conversation. Name the subject, not the
  activity: "Export pipeline" rather than "Discussion". Two to five of them.
  If the meeting only really covered one thing, use one section.
- Sections carry the DISCUSSION: findings, current state, reasoning, numbers,
  anything worth remembering. They must not restate decisions, action items or
  open questions, which each have their own field. A section bullet that reads
  "Decision: none" or "Action items: Sam will fix it" is wrong.
    Good:  "The JSX exporter is finished, but computed styles drop border
            radius on nested frames, so anything nested exports wrong."
    Bad:   "Decision: none" / "Action item - Sam: I'll own it."
- The title names the subject. "Export pipeline and pricing", never
  "Meeting notes" and never a date.
- A decision is a question that got settled. A preference is not a decision.
- An action item is a commitment someone made. If nobody committed to anything,
  return an empty list. Do not manufacture next steps to look useful.
- Open questions are things raised and left hanging. Include them even when
  they feel minor; they are what people forget.
- Never invent an assignee or a deadline that was not said out loud. Use "".
- Report a deadline exactly as spoken. Do not do calendar arithmetic; that is
  handled downstream.
- Every decision and action item must quote the line it came from, copied
  word for word out of the transcript. The quote is checked against the
  transcript, and anything whose quote is not found is discarded. Do not
  reconstruct or tidy a quote; copy it.
- Judge the transcript honestly in \`coverage\`. If it is short, one-sided or
  garbled, say so and say what to do about it. Do not write a confident note
  on top of audio that does not support one.
- Write plain ASCII. Ordinary hyphens, never en dashes or em dashes.

Transcript:
${transcript}`

  const parsed = plain(
    JSON.parse(await chat(apiKey, EXTRACT_MODEL, prompt, SUMMARY_SCHEMA, spend)) as RawSummary,
  )
  const hay = forMatch(transcript)

  const d = verify(parsed.decisions ?? [], hay)
  const a = verify(parsed.action_items ?? [], hay)
  if (d.dropped || a.dropped) {
    console.warn(
      `[ai] dropped ${d.dropped} decision(s) and ${a.dropped} action item(s) whose quotes were not in the transcript`,
    )
  }

  return {
    ...parsed,
    sections: parsed.sections ?? [],
    open_questions: parsed.open_questions ?? [],
    coverage: parsed.coverage ?? { quality: 'good', note: '' },
    anchored: notes
      ? (parsed.anchored ?? []).map((a) => ({
          ...a,
          // Only ever downgrades: the model saying "supported" about something
          // the transcript never mentions is the failure this catches.
          supported: a.supported && noteIsCovered(a.note, hay),
        }))
      : [],
    decisions: d.kept,
    action_items: a.kept.map((x) => ({ ...x, due: resolveDue(x.due_text, today) })),
    unverified: d.dropped + a.dropped,
    model: extractModelName(),
  }
}

/**
 * Answer a question about one meeting, from its transcript and note.
 *
 * Deliberately grounded and allowed to fail: a meeting note people trust has
 * to be able to say the meeting did not cover something, rather than producing
 * a plausible answer from nowhere.
 */
export async function askMeeting(
  apiKey: string,
  question: string,
  ctx: { title: string; when: string; transcript: string; tldr?: string },
) {
  const prompt = `You are answering a question about one meeting for ${TEAM}.

Meeting: ${ctx.title} (${ctx.when})
${ctx.tldr ? `Summary: ${ctx.tldr}\n` : ''}
Rules:
- Answer only from the transcript below. If it does not contain the answer, say
  so plainly: "That did not come up." Do not reason from general knowledge about
  what such a meeting probably covered.
- Quote the relevant line when it helps, in double quotes.
- Be brief. Two or three sentences, or a short list. This is a chat reply, not
  a report.
- Write plain ASCII with ordinary hyphens.

Transcript:
${ctx.transcript}

Question: ${question}`

  return plain(await chat(apiKey, EXTRACT_MODEL, prompt))
}
