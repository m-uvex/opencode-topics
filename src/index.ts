import { Plugin } from "@opencode/plugin"
import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"

interface SessionState {
  seen: boolean
  // the last title the host itself wrote, used to un-drift after an undo
  hostTitle: string | null
  currentTitle: string | null
  // salient stems describing the topic the session is believed to be on
  topic: Set<string>
  lastCheckedIndex: number
  lastCheckedUsers: number
  // consecutive low coverage checks, renamed at options.confirmations
  pendingDrift: number
  isRenaming: boolean
}

interface TopicMessage {
  // "compaction" is the summary that replaces the history after a compact
  role: "user" | "assistant" | "compaction"
  text: string
}

interface TopicPort {
  readMessages(sessionID: string): Promise<TopicMessage[]>
  readTitle(sessionID: string): Promise<string | null>
  writeTitle(sessionID: string, title: string): Promise<void>
  nameTopic(sessionID: string, userText: string, assistantText: string, isDrift: boolean): Promise<string | null>
}

interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

// What caused a check. "message" is the original behavior; the rest keep the
// title in sync with the session when history changes without a prompt.
type Trigger = "message" | "compaction" | "undo" | "redo" | "fork" | "rename"

type TitlesBy = "hybrid" | "algorithm" | "ai"

export interface TopicsOptions {
  model?: ModelRef
  titlesBy: TitlesBy
  // check after this many new user messages
  checkEvery: number
  // user turns in the drift window
  windowTurns: number
  // share of the new window the topic must cover to stay on topic
  threshold: number
  // consecutive low coverage checks before the title changes
  confirmations: number
  on: Set<Trigger>
}

const DEFAULT_ON: Trigger[] = ["message", "compaction", "undo", "redo", "fork", "rename"]

// The host rejects opencode's free-tier models for plugin generation, so an
// explicit model can be configured: options.model > session model > default
function normalizeModel(raw: unknown): ModelRef | undefined {
  const m = raw as { providerID?: unknown; id?: unknown; modelID?: unknown; variant?: unknown } | null
  if (!m || typeof m.providerID !== "string") return undefined
  const id = typeof m.id === "string" ? m.id : typeof m.modelID === "string" ? m.modelID : undefined
  if (!id) return undefined
  return { id, providerID: m.providerID, variant: typeof m.variant === "string" ? m.variant : undefined }
}

// Bad config must never break the plugin, so every value falls back to default
export function normalizeOptions(raw: unknown): TopicsOptions {
  const o = (raw ?? {}) as Record<string, unknown>
  const num = (value: unknown, fallback: number, min: number, max: number, integer = true) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback
    const clamped = Math.min(max, Math.max(min, value))
    return integer ? Math.floor(clamped) : clamped
  }
  const titlesBy: TitlesBy =
    o.titlesBy === "ai" || o.titlesBy === "algorithm" ? o.titlesBy : "hybrid"
  let on = new Set<Trigger>(DEFAULT_ON)
  if (Array.isArray(o.on)) {
    const picked = o.on.filter((t): t is Trigger => typeof t === "string" && (DEFAULT_ON as string[]).includes(t))
    if (picked.length > 0) on = new Set(picked)
  }
  return {
    model: normalizeModel(o.model),
    titlesBy,
    checkEvery: num(o.checkEvery, 1, 1, 20),
    windowTurns: num(o.windowTurns, 1, 1, 5),
    threshold: num(o.threshold, 0.2, 0.05, 1, false),
    confirmations: num(o.confirmations, 2, 1, 5),
    on,
  }
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "then", "here", "there", "when", "where",
  "why", "how", "all", "each", "few", "more", "most", "other", "some",
  "no", "nor", "not", "only", "own", "so", "than", "too", "very", "just",
  "and", "but", "if", "or", "because", "until", "while", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "him", "his", "she", "her", "it", "its", "they", "them", "their", "what",
  "which", "who", "whom", "please", "help", "want", "like", "make", "create",
  "write", "add", "get", "let", "try", "look", "work", "ok", "yes", "sure"
])

// Instruction verbs, quantifiers, temporal and discourse filler that survive
// the general stop list but describe the request/flow rather than the topic.
const TITLE_STOP_WORDS = new Set([
  // temporal & discourse transitions: they order thoughts, not topics
  "now", "next", "still", "finally", "currently", "soon", "later", "again",
  "already", "okay", "alright", "well", "yeah", "yes", "sure", "maybe",
  "probably", "actually", "basically", "anyway", "besides",
  "first", "second", "third", "last",
  // request framing
  "explain", "describe", "described", "describes", "tell", "tells", "told",
  "show", "shows", "shown", "list", "lists", "summarize", "summary",
  "give", "gives", "given", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "short", "brief", "simple", "quick",
  "sentence", "sentences", "paragraph", "paragraphs", "word", "words",
  "detail", "details", "exactly", "step", "steps", "about", "over", "onto",
  "upon", "via", "per", "also", "really",
  "thing", "things", "stuff",
  // generic verbs: they connect topics, they are not the topic
  "affect", "affects", "impact", "impacts", "cause", "causes", "change",
  "changes", "fix", "fixes", "prevent", "prevents", "improve", "improves",
  "reduce", "reduces", "increase", "increases", "use", "uses", "using",
  "help", "helps", "mean", "means", "lead", "leads", "keep", "keeps",
  "run", "runs", "set", "sets", "setting", "setup",
  "configure", "configures", "configuring", "configuration", "configured",
  "install", "installs", "installing", "installation", "installed",
  "build", "builds", "building", "built",
  "update", "updates", "updating", "updated",
  // workspace filler: it is where the work happens, not what the work is
  "repo", "repos", "repository", "repositories",
])

// Keeps dots, hyphens and underscores inside tokens so package.json, tsconfig.json
// and round-robin stay whole instead of splitting into separate words.
function tokenizeForTitle(text: string): string[] {
  return text.match(/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*/g) ?? []
}

function isTitleWord(word: string): boolean {
  if (word.length < 2 || /^\d+$/.test(word)) return false
  const lower = word.toLowerCase()
  return !STOP_WORDS.has(lower) && !TITLE_STOP_WORDS.has(lower)
}

// Crude noun plural stripping, enough that "turtles" and "Turtle facts" count
// as the same topic. Verbs are left alone on purpose: stripping them turns
// "stored" and "store" into different keys, which is worse than no stemming.
function stem(word: string): string {
  const w = word.toLowerCase()
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y" // policies -> policy
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2) // boxes -> box
  if (w.length > 4 && w.endsWith("s") && !/(ss|us)$/.test(w)) return w.slice(0, -1) // turtles -> turtle
  return w
}

// The drift check compares salient words only, using the same filter the titles
// use: a turn made of politeness and instruction verbs has no topic signal, so
// it can no longer read as drift.
function extractKeywords(text: string): Set<string> {
  return new Set(tokenizeForTitle(text).filter(isTitleWord).map(stem))
}

// How much of the new window the current topic already covers. The window is the
// denominator, not the smaller set, so a short host title can no longer make a
// long off topic turn look on topic: 2 of 3 new words matching still passes,
// 2 of 10 does not.
function coverage(topic: Set<string>, window: Set<string>): number {
  if (window.size === 0) return 1
  if (topic.size === 0) return 1
  let matches = 0
  for (const word of window) {
    if (topic.has(word)) matches++
  }
  return matches / window.size
}

// The newest user turns and everything the assistant said after them
function windowMessages(messages: TopicMessage[], windowTurns: number): TopicMessage[] {
  let users = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      users++
      if (users > windowTurns) return messages.slice(i + 1)
    }
  }
  return messages
}

function userTexts(messages: TopicMessage[]): string[] {
  return messages.filter(m => m.role === "user").map(m => m.text)
}

function assistantText(messages: TopicMessage[]): string {
  return messages.filter(m => m.role === "assistant").map(m => m.text).join(" ")
}

function sanitizeTitle(title: string, maxLength = 60): string {
  return title
    .replace(/[^\w\s.\-:~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

function buildPrompt(userSnippet: string, assistantSnippet: string, isDrift: boolean): string {
  return `Summarize the topic of this conversation in 3-5 words in title case.
${isDrift ? "This conversation shifted into a new sub-topic. Summarize the NEW active focus." : ""}

User: "${userSnippet.slice(0, 300)}"
Assistant: "${assistantSnippet.slice(0, 300)}"

Rules:
- 3 to 5 words maximum
- Never start the title with transition words like "Now", "Next", "Still", "Currently", "Finally" or verbs like "Set Up", "Configure", "Add"
- Focus on the noun/subject being discussed
- Keep dots in filenames like package.json or file.ts
- Return ONLY the title text, nothing else.`
}

function readFirstLine(text: string): string | null {
  const line = text.trim().split("\n")[0].trim()
  const title = sanitizeTitle(line)
  return title.length > 0 ? title : null
}

function toTitleCase(word: string): string {
  // filenames and identifiers keep their own casing
  if (word.includes(".") || word.includes("_")) return word
  if (word.includes("-")) return word.split("-").map(toTitleCase).join("-")
  if (word === word.toUpperCase()) return word // acronyms: DNS, TTL, KP
  if (/[a-z][A-Z]/.test(word)) return word // camelCase
  return word[0].toUpperCase() + word.slice(1).toLowerCase()
}

interface TitleWord {
  word: string // as written, casing preserved
  key: string // stem, used for matching
}

// Deduplicated candidates in order of first appearance
function titleCandidates(text: string): TitleWord[] {
  const seen = new Set<string>()
  const out: TitleWord[] = []
  for (const word of tokenizeForTitle(text)) {
    if (!isTitleWord(word)) continue
    const key = stem(word)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ word, key })
  }
  return out
}

// The same filter without deduplication, so the assistant's own sequence of
// words stays intact for phrase matching
function titleSequence(text: string): TitleWord[] {
  return tokenizeForTitle(text)
    .filter(isTitleWord)
    .map(word => ({ word, key: stem(word) }))
}

interface Echo {
  has(key: string): boolean
}

// The assistant's own phrasing wins when it states the topic in one piece:
// "DNS round robin failover" pulled out of a longer sentence reads better than
// the same words picked one by one. Repeats inside a phrase are dropped, so a
// chatty reply cannot produce a title like "TTL DNS TTL Failover".
function bestPhrase(assistantText: string, candidates: Set<string>): string[] {
  const words = titleSequence(assistantText).filter(w => candidates.has(w.key))
  let best: string[] = []
  let i = 0
  while (i < words.length) {
    let run = 0
    const seen = new Set<string>()
    const picked: string[] = []
    while (run < 8 && i + run < words.length && candidates.has(words[i + run].key)) {
      const w = words[i + run]
      if (!seen.has(w.key)) {
        seen.add(w.key)
        picked.push(w.word)
      }
      run++
    }
    if (picked.length >= 3 && picked.length > best.length) best = picked
    i += run + 1
  }
  return best
}

// Averaged scoring, so a tight run of three echoed words beats a loose run of
// five. Larger windows win ties because they are scored first.
function densityOf(words: string[], echo: Echo): number {
  if (words.length === 0) return 0
  let score = 0
  for (const word of words) {
    score += echo.has(stem(word)) ? 2 : 1
  }
  return score / words.length
}

function bestWindow(candidates: TitleWord[], echo: Echo): string[] {
  if (candidates.length < 3) return []
  let best: TitleWord[] = []
  let bestScore = -1
  for (let size = Math.min(5, candidates.length); size >= 3; size--) {
    for (let i = 0; i + size <= candidates.length; i++) {
      const win = candidates.slice(i, i + size)
      let score = 0
      for (const w of win) {
        score += echo.has(w.key) ? 2 : 1
      }
      const average = score / size
      if (average > bestScore + 1e-9) {
        bestScore = average
        best = win
      }
    }
  }
  return best.map(w => w.word)
}

function titleFromTexts(userText: string, replyText: string): string | null {
  const candidates = titleCandidates(userText)
  if (candidates.length < 3) return null
  const echoed = new Set(titleSequence(replyText).map(w => w.key))
  const echo: Echo = { has: key => echoed.has(key) }

  const phrase = bestPhrase(replyText, new Set(candidates.map(c => c.key)))
  const window = bestWindow(candidates, echo)
  // The reply's own phrasing wins when it is at least as informative as the
  // best token window: a tight three word phrase beats a loose five word run,
  // and a window stuffed with echoed words beats a thin phrase.
  const words =
    phrase.length >= 3 && densityOf(phrase, echo) >= densityOf(window, echo) - 1e-9 ? phrase : window
  if (words.length < 3) return null
  const title = sanitizeTitle(words.slice(0, 5).map(toTitleCase).join(" "))
  return title.split(" ").length >= 3 ? title : null
}

export function buildExtractiveTitle(messages: TopicMessage[], options: TopicsOptions): string | null {
  const lastUser = messages.map(m => m.role).lastIndexOf("user")
  if (lastUser === -1) return null
  const allUserTexts = userTexts(messages)
  const windowAssistant = assistantText(messages)
  const replyToLastUser = assistantText(messages.slice(lastUser + 1))

  // Title the newest exchange first so an early drift does not blend the old
  // topic into the new one; widen to the whole window when it is too thin.
  const newest = allUserTexts.slice(-options.windowTurns).join(" ")
  const stages: Array<[string, string]> = [
    [newest, replyToLastUser || windowAssistant],
    [allUserTexts.join(" "), windowAssistant],
  ]
  for (const [userText, replyText] of stages) {
    const title = titleFromTexts(userText, replyText)
    if (title) return title
  }
  return null
}

// titlesBy decides who writes: the token algorithm, the model, or the algorithm
// with the model as the fallback when the window has no three topical words.
async function titleFor(
  port: TopicPort,
  sessionID: string,
  messages: TopicMessage[],
  options: TopicsOptions,
): Promise<string | null> {
  const userText = userTexts(messages).join(" ")
  const replyText = assistantText(messages)
  if (options.titlesBy === "ai") return port.nameTopic(sessionID, userText, replyText, true)
  const extracted = buildExtractiveTitle(messages, options)
  if (extracted) return extracted
  return options.titlesBy === "hybrid" ? port.nameTopic(sessionID, userText, replyText, true) : null
}

function isDriftTitle(title: string | null): boolean {
  return !!title && title.startsWith("~ ")
}

// Extract a concise anchor phrase from the original/host title to preserve as
// the topic umbrella when a sub-topic takes over (e.g. "Immich on Lunar: Authelia Oauth").
function cleanHostAnchor(hostTitle: string | null): string | null {
  if (!hostTitle) return null
  const bare = hostTitle.replace(/^~\s*/, "").trim()
  if (!bare) return null
  // Drop any existing sub-clause delimiter
  const chunk = bare.split(/\s*[:|]\s*|\s+-\s+/)[0].trim()
  const tokens = tokenizeForTitle(chunk)
  let start = 0
  while (start < tokens.length && !isTitleWord(tokens[start])) start++
  let end = tokens.length
  while (end > start && !isTitleWord(tokens[end - 1])) end--
  const salient = tokens.slice(start, end)
  if (salient.length === 0) return null
  return salient.slice(0, 3).map(toTitleCase).join(" ")
}

function composeDriftTitle(hostTitle: string | null, newFocus: string): string {
  const anchor = cleanHostAnchor(hostTitle)
  if (!anchor) return `~ ${newFocus}`
  const aNorm = anchor.toLowerCase()
  const fNorm = newFocus.toLowerCase()
  if (fNorm.includes(aNorm) || aNorm.includes(fNorm)) return `~ ${newFocus}`
  const combined = `~ ${anchor}: ${newFocus}`
  return sanitizeTitle(combined, 60)
}

function newTopicSet(...parts: Array<Set<string> | string>): Set<string> {
  const topic = new Set<string>()
  for (const part of parts) {
    const words = typeof part === "string" ? extractKeywords(part) : part
    for (const word of words) topic.add(word)
  }
  return topic
}

async function recordBaseline(
  port: TopicPort,
  state: SessionState,
  sessionID: string,
  messages: TopicMessage[],
  options: TopicsOptions,
): Promise<void> {
  const title = await port.readTitle(sessionID)
  // a drifted title from a previous run is not the host's own opinion
  state.hostTitle = isDriftTitle(title) ? null : title
  state.currentTitle = title
  state.topic = newTopicSet(title ?? "", userTexts(messages).slice(-options.windowTurns).join(" "))
  state.seen = true
  state.lastCheckedIndex = messages.length
  state.lastCheckedUsers = userTexts(messages).length
  state.pendingDrift = 0
}

// After messages vanish (undo) or come back (redo) the title may describe
// history that is no longer in the session, so re-derive it from what is left.
async function reconcileTitle(
  port: TopicPort,
  state: SessionState,
  sessionID: string,
  messages: TopicMessage[],
  options: TopicsOptions,
): Promise<void> {
  const recent = windowMessages(messages, options.windowTurns)
  const recentUserText = userTexts(recent).join(" ")
  const windowKeywords = extractKeywords(recentUserText)
  state.topic = newTopicSet(state.currentTitle ?? "", windowKeywords)
  state.lastCheckedIndex = messages.length
  state.lastCheckedUsers = userTexts(messages).length
  state.pendingDrift = 0

  // Nothing topical left to judge the title against (an empty session, or only
  // a summary): keep the title it has.
  if (windowKeywords.size === 0) return

  if (!isDriftTitle(state.currentTitle)) return

  // The messages the drift title was based on are gone: if the session is back
  // on the host's original topic, give the host its own title back.
  if (state.hostTitle && !isDriftTitle(state.hostTitle)) {
    const hostKeywords = extractKeywords(state.hostTitle)
    if (hostKeywords.size > 0 && coverage(hostKeywords, windowKeywords) >= options.threshold) {
      state.currentTitle = state.hostTitle
      state.topic = newTopicSet(hostKeywords, windowKeywords)
      await port.writeTitle(sessionID, state.hostTitle)
      return
    }
  }

  // Still off the original topic: title whatever history is left.
  const newTitle = await titleFor(port, sessionID, recent, options)
  if (newTitle && newTitle.toLowerCase() !== (state.currentTitle ?? "").toLowerCase()) {
    const fullTitle = composeDriftTitle(state.hostTitle, newTitle)
    state.currentTitle = fullTitle
    state.topic = newTopicSet(fullTitle, windowKeywords)
    await port.writeTitle(sessionID, fullTitle)
  }
}

export async function checkSession(
  port: TopicPort,
  sessions: Map<string, SessionState>,
  sessionID: string,
  options: TopicsOptions,
  trigger: Trigger,
): Promise<void> {
  let state = sessions.get(sessionID)
  if (!state) {
    state = {
      seen: false,
      hostTitle: null,
      currentTitle: null,
      topic: new Set<string>(),
      lastCheckedIndex: 0,
      lastCheckedUsers: 0,
      pendingDrift: 0,
      isRenaming: false,
    }
    sessions.set(sessionID, state)
  }

  if (state.isRenaming) return

  const messages = await port.readMessages(sessionID)
  if (messages.length === 0) return

  // The host names the session on its own, so the first sight only records
  // where it stands: the title plus what the newest turns are about.
  if (!state.seen || trigger === "fork") {
    await recordBaseline(port, state, sessionID, messages, options)
    return
  }

  // The history was rewritten into a summary, not changed topic: re-anchor on
  // what the session says it is about now instead of reading the rewrite as
  // drift. This also resets the counters, which otherwise go backwards when
  // the summary replaces the user messages they were counting.
  if (trigger === "compaction") {
    const summary = messages.filter(m => m.role === "compaction").map(m => m.text).join(" ")
    const recentUserText = userTexts(windowMessages(messages, options.windowTurns)).join(" ")
    state.topic = newTopicSet(state.currentTitle ?? "", summary, recentUserText)
    state.pendingDrift = 0
    state.lastCheckedIndex = messages.length
    state.lastCheckedUsers = userTexts(messages).length
    return
  }

  if (trigger === "undo" || trigger === "redo") {
    await reconcileTitle(port, state, sessionID, messages, options)
    return
  }

  if (trigger === "rename") {
    // The host retitled the session: follow it, unless it is our own drift
    // title coming back through the event stream.
    const title = await port.readTitle(sessionID)
    if (title && title !== state.currentTitle && !isDriftTitle(title)) {
      state.currentTitle = title
      // the host often titles the session a moment after the first prompt, so
      // this is where the title an undo can fall back to usually arrives
      state.hostTitle = title
      state.topic = extractKeywords(title)
    }
    return
  }

  // checkEvery: wait until enough new user messages have piled up
  const userCount = userTexts(messages).length
  if (messages.length === state.lastCheckedIndex) return
  if (userCount - state.lastCheckedUsers < options.checkEvery) return

  const recent = windowMessages(messages, options.windowTurns)
  const recentUserText = userTexts(recent).join(" ")
  const windowKeywords = extractKeywords(recentUserText)

  // Not enough signal in the window: neither drift nor confirmation, just wait
  if (windowKeywords.size < 3) {
    state.lastCheckedIndex = messages.length
    state.lastCheckedUsers = userCount
    return
  }

  const overlap = coverage(state.topic, windowKeywords)
  if (overlap >= options.threshold) {
    state.pendingDrift = 0
    state.lastCheckedIndex = messages.length
    state.lastCheckedUsers = userCount
    return
  }

  state.pendingDrift++
  if (state.pendingDrift < options.confirmations) {
    // a single odd question should not retitle the session; the next turn
    // either confirms the drift or clears it
    state.lastCheckedIndex = messages.length
    state.lastCheckedUsers = userCount
    return
  }

  state.isRenaming = true
  try {
    const newTitle = await titleFor(port, sessionID, recent, options)
    if (newTitle && newTitle.toLowerCase() !== (state.currentTitle ?? "").toLowerCase()) {
      // The "~ " prefix marks a title that moved off the original topic, preserving
      // the umbrella topic anchor when one exists (e.g. "~ Immich: Authelia Oauth Client")
      const fullTitle = composeDriftTitle(state.hostTitle, newTitle)
      state.currentTitle = fullTitle
      state.topic = newTopicSet(fullTitle, recentUserText)
      state.pendingDrift = 0
      await port.writeTitle(sessionID, fullTitle)
    } else {
      // same topic after all, or nothing better to say
      state.pendingDrift = 0
    }
    state.lastCheckedIndex = messages.length
    state.lastCheckedUsers = userCount
  } finally {
    state.isRenaming = false
  }
}

// Payloads differ between event families: the live session events carry data,
// the newer ones carry properties.
function eventSessionID(event: unknown): string | null {
  const e = event as Record<string, any> | null
  return (
    e?.properties?.sessionID ??
    e?.data?.sessionID ??
    e?.properties?.session?.id ??
    e?.data?.session?.id ??
    e?.properties?.info?.id ??
    e?.data?.info?.id ??
    null
  )
}

function eventTitle(event: unknown): string | null {
  const e = event as Record<string, any> | null
  const info = e?.properties?.info ?? e?.data?.info
  return typeof info?.title === "string" ? info.title : null
}

function triggerFromEventType(type: string): Trigger | null {
  switch (type) {
    case "session.execution.succeeded":
    case "session.execution.failed":
      return "message"
    // compaction: the runtime emits session.compaction.ended, the types
    // declare the older session.compacted / session.next.compaction.ended
    case "session.compacted":
    case "session.compaction":
    case "session.compaction.ended":
    case "session.next.compaction.ended":
      return "compaction"
    // the runtime drops the "next" segment the types still carry
    case "session.revert.staged":
    case "session.revert.committed":
    case "session.next.revert.staged":
    case "session.next.revert.committed":
      return "undo"
    case "session.revert.cleared":
    case "session.unreverted":
    case "session.next.revert.cleared":
      return "redo"
    case "session.created":
    case "session.forked":
    case "session.fork":
      return "fork"
    case "session.updated":
    case "session.renamed":
      return "rename"
    default:
      return null
  }
}

const v2Plugin = Plugin.define({
  id: "topics",
  async setup(ctx) {
    const options = normalizeOptions(ctx.options)
    const sessions = new Map<string, SessionState>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const port: TopicPort = {
      async readMessages(sessionID) {
        const list = await ctx.session.context({ sessionID })
        const out: TopicMessage[] = []
        for (const item of list) {
          if (item.type === "user") {
            out.push({ role: "user", text: item.text })
          } else if (item.type === "assistant") {
            const text = (item.content || [])
              .filter(part => part.type === "text")
              .map(part => part.text)
              .join(" ")
            if (text) out.push({ role: "assistant", text })
          } else if (item.type === "compaction" && "summary" in item && item.summary) {
            out.push({ role: "compaction", text: item.summary })
          }
        }
        return out
      },
      async readTitle(sessionID) {
        try {
          const session = await ctx.session.get({ sessionID })
          return session.title || null
        } catch {
          return null
        }
      },
      async writeTitle(sessionID, title) {
        await ctx.session.update({ sessionID, title })
      },
      async nameTopic(sessionID, userText, assistantText, isDrift) {
        const prompt = buildPrompt(userText, assistantText, isDrift)
        const candidates: (ModelRef | undefined)[] = []
        const push = (ref: ModelRef | undefined) => {
          if (ref && !candidates.some(c => c && c.providerID === ref.providerID && c.id === ref.id)) {
            candidates.push(ref)
          }
        }
        push(normalizeModel(options.model))
        const session = await ctx.session.get({ sessionID }).catch(() => null)
        if (session?.model?.id) {
          push({ id: session.model.id, providerID: session.model.providerID, variant: session.model.variant })
        }
        candidates.push(undefined) // configured default

        for (const model of candidates) {
          try {
            const res = await ctx.generate.text({ prompt, model })
            return readFirstLine(res.text)
          } catch {
            // fall through to the next candidate model
          }
        }
        return null
      },
    }

    // Compaction, revert and rename events arrive in bursts: one debounced
    // check per session is enough, and re-running it is harmless.
    const schedule = (sessionID: string, trigger: Trigger) => {
      const pending = timers.get(sessionID)
      if (pending) clearTimeout(pending)
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID)
          void checkSession(port, sessions, sessionID, options, trigger).catch(() => {})
        }, 300),
      )
    }

    const controller = new AbortController()
    const subscribe = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const type = String((event as { type?: unknown }).type)
          const sessionID = eventSessionID(event)
          if (!sessionID) continue

          if (type === "session.deleted") {
            sessions.delete(sessionID)
            const pending = timers.get(sessionID)
            if (pending) {
              clearTimeout(pending)
              timers.delete(sessionID)
            }
            continue
          }

          const trigger = triggerFromEventType(type)
          if (!trigger || !options.on.has(trigger)) continue
          if (trigger === "rename") {
            const title = eventTitle(event)
            const state = sessions.get(sessionID)
            // ignore the echo of our own writes and unrelated session updates
            if (!title || title === state?.currentTitle || isDriftTitle(title)) continue
          }
          if (trigger === "message") {
            void checkSession(port, sessions, sessionID, options, trigger).catch(() => {})
          } else {
            schedule(sessionID, trigger)
          }
        } catch {
          // one bad event must not break the subscription
        }
      }
    })()

    return () => {
      controller.abort()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      return subscribe
    }
  },
})

function sessionIdFromEvent(event: unknown): string | null {
  const e = event as any
  return (
    e?.properties?.sessionID ||
    e?.properties?.session?.id ||
    e?.properties?.part?.sessionID ||
    e?.sessionID ||
    null
  )
}

async function v1Server(input: PluginInput, pluginOptions?: Record<string, unknown>): Promise<Hooks> {
  const { client } = input
  const options = normalizeOptions(pluginOptions)
  const sessions = new Map<string, SessionState>()

  const port: TopicPort = {
    async readMessages(sessionID) {
      try {
        const res = await client.session.messages({ path: { id: sessionID } }) as any
        const list = res?.data || res || []
        const out: TopicMessage[] = []
        for (const item of list) {
          const rawRole = item?.info?.role || item?.role || "user"
          const role: TopicMessage["role"] = rawRole === "assistant" ? "assistant" : "user"
          const parts = item?.parts || []
          for (const p of parts) {
            if (p?.type === "text" && p?.text) {
              out.push({ role, text: p.text })
            }
          }
        }
        return out
      } catch {
        return []
      }
    },
    async readTitle(sessionID) {
      try {
        const res = await client.session.get({ path: { id: sessionID } }) as any
        return res?.data?.title || res?.title || null
      } catch {
        return null
      }
    },
    async writeTitle(sessionID, title) {
      await client.session.update({ path: { id: sessionID }, body: { title } })
    },
    async nameTopic(_sessionID, userText, assistantText, isDrift) {
      let tempId: string | null = null
      try {
        const created = await client.session.create({ body: { title: "topics-eval" } }) as any
        tempId = created?.id || created?.data?.id
        if (!tempId) return null

        const res = await client.session.prompt({
          path: { id: tempId },
          body: { parts: [{ type: "text", text: buildPrompt(userText, assistantText, isDrift) }] }
        }) as any

        const parts = res?.parts || res?.data?.parts || []
        for (const p of parts) {
          if (p?.type === "text" && p?.text) return readFirstLine(p.text)
        }
        return null
      } catch {
        return null
      } finally {
        if (tempId) {
          client.session.delete({ path: { id: tempId } }).catch(() => {})
        }
      }
    },
  }

  return {
    event: async ({ event }) => {
      const sessionID = sessionIdFromEvent(event)
      if (!sessionID) return

      const type = String((event as { type?: unknown }).type)
      if (type === "session.deleted") {
        sessions.delete(sessionID)
        return
      }
      // v1 only ever checked when a session went idle
      if (type === "session.idle" && options.on.has("message")) {
        await checkSession(port, sessions, sessionID, options, "message")
      }
    }
  }
}

export default {
  ...v2Plugin,
  server: v1Server,
} satisfies PluginModule & ReturnType<typeof Plugin.define>
