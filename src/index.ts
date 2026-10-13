import { Plugin } from "@opencode/plugin"
import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"

interface SessionState {
  baseline: string | null
  currentTitle: string | null
  lastCheckedIndex: number
  driftCount: number
  isRenaming: boolean
}

interface TopicMessage {
  role: "user" | "assistant"
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

// The host rejects opencode's free-tier models for plugin generation, so an
// explicit model can be configured: options.model > session model > default
function normalizeModel(raw: unknown): ModelRef | undefined {
  const m = raw as { providerID?: unknown; id?: unknown; modelID?: unknown; variant?: unknown } | null
  if (!m || typeof m.providerID !== "string") return undefined
  const id = typeof m.id === "string" ? m.id : typeof m.modelID === "string" ? m.modelID : undefined
  if (!id) return undefined
  return { id, providerID: m.providerID, variant: typeof m.variant === "string" ? m.variant : undefined }
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

function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  return new Set(words)
}

function computeOverlap(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0
  let matches = 0
  for (const item of setA) {
    if (setB.has(item)) matches++
  }
  return matches / Math.min(setA.size, setB.size)
}

function sanitizeTitle(title: string, maxLength = 50): string {
  const cleaned = title
    .replace(/[^\w\s.\-~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length <= maxLength) return cleaned
  // cut on a word boundary so a long title never ends mid-word
  const cut = cleaned.slice(0, maxLength)
  const boundary = cut.lastIndexOf(" ")
  return (boundary > 10 ? cut.slice(0, boundary) : cut).trim()
}

function buildPrompt(userSnippet: string, assistantSnippet: string, isDrift: boolean): string {
  return `Summarize the topic of this conversation in 3-5 words in title case.
${isDrift ? "This conversation shifted into a new sub-topic. Summarize the NEW active focus." : ""}

User: "${userSnippet.slice(0, 300)}"
Assistant: "${assistantSnippet.slice(0, 300)}"

Rules:
- 3 to 5 words maximum
- Keep dots in filenames like package.json or file.ts
- Return ONLY the title text, nothing else.`
}

function readFirstLine(text: string): string | null {
  const line = text.trim().split("\n")[0].trim()
  const title = sanitizeTitle(line)
  return title.length > 0 ? title : null
}

// Instruction verbs, quantifiers and filler that survive the general stop list
// but describe the request rather than the topic.
const TITLE_STOP_WORDS = new Set([
  "explain", "describe", "described", "describes", "tell", "tells", "told",
  "show", "shows", "shown", "list", "lists", "summarize", "summary",
  "give", "gives", "given", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "short", "brief", "simple", "quick",
  "sentence", "sentences", "paragraph", "paragraphs", "word", "words",
  "detail", "details", "exactly", "step", "steps", "about", "over", "onto",
  "upon", "via", "per", "also", "really", "actually", "basically",
  "thing", "things", "stuff",
  // generic verbs: they connect topics, they are not the topic
  "affect", "affects", "impact", "impacts", "cause", "causes", "change",
  "changes", "fix", "fixes", "prevent", "prevents", "improve", "improves",
  "reduce", "reduces", "increase", "increases", "use", "uses", "using",
  "help", "helps", "mean", "means", "lead", "leads", "keep", "keeps",
  "run", "runs",
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

function toTitleCase(word: string): string {
  // filenames and identifiers keep their own casing
  if (word.includes(".") || word.includes("_")) return word
  if (word.includes("-")) return word.split("-").map(toTitleCase).join("-")
  if (word === word.toUpperCase()) return word // acronyms: DNS, TTL, KP
  if (/[a-z][A-Z]/.test(word)) return word // camelCase
  return word[0].toUpperCase() + word.slice(1).toLowerCase()
}

// Words the assistant actually echoed are the topical core; a request full of
// politeness and instruction verbs then has nothing left, which is the signal
// to fall back to the model.
function titleCandidates(userText: string, assistantText: string): string[] {
  const seen = new Set<string>()
  const userWords: string[] = []
  for (const word of tokenizeForTitle(userText)) {
    if (!isTitleWord(word)) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    userWords.push(word)
  }
  if (!assistantText) return userWords
  const echoed = new Set(
    tokenizeForTitle(assistantText).filter(isTitleWord).map(w => w.toLowerCase())
  )
  const shared = userWords.filter(w => echoed.has(w.toLowerCase()))
  return shared.length >= 3 ? shared : userWords
}

export function buildExtractiveTitle(messages: TopicMessage[]): string | null {
  const lastUser = messages.map(m => m.role).lastIndexOf("user")
  if (lastUser === -1) return null
  const userTexts = messages.filter(m => m.role === "user").map(m => m.text)
  const windowAssistant = messages.filter(m => m.role === "assistant").map(m => m.text).join(" ")
  const replyToLastUser = messages.slice(lastUser + 1).filter(m => m.role === "assistant").map(m => m.text).join(" ")

  // Title the newest exchange first so an early drift does not blend the old
  // topic into the new one; widen to the whole window when it is too thin.
  const stages: Array<[string, string]> = [
    [messages[lastUser].text, replyToLastUser || windowAssistant],
    [userTexts.join(" "), windowAssistant],
  ]
  for (const [userText, assistantText] of stages) {
    const words = titleCandidates(userText, assistantText).slice(0, 5).map(toTitleCase)
    if (words.length < 3) continue
    const title = sanitizeTitle(words.join(" "))
    if (title.split(" ").length >= 3) return title
  }
  return null
}

async function checkSession(
  port: TopicPort,
  sessions: Map<string, SessionState>,
  sessionID: string
) {
  let state = sessions.get(sessionID)
  if (!state) {
    state = {
      baseline: null,
      currentTitle: null,
      lastCheckedIndex: 0,
      driftCount: 0,
      isRenaming: false,
    }
    sessions.set(sessionID, state)
  }

  if (state.isRenaming) return

  const messages = await port.readMessages(sessionID)
  if (messages.length === 0) return

  // The host names the session on its own, so the first sight only records the baseline
  if (!state.baseline) {
    const title = await port.readTitle(sessionID)
    state.baseline = title || messages.find(m => m.role === "user")?.text || ""
    state.currentTitle = title
    state.lastCheckedIndex = messages.length
    return
  }

  // History shrinks on compaction, so only skip when nothing has changed
  if (messages.length === state.lastCheckedIndex) return

  const recentMessages = messages.slice(-4)
  const recentUserText = recentMessages.filter(m => m.role === "user").map(m => m.text).join(" ")
  const recentAssistantText = recentMessages.filter(m => m.role === "assistant").map(m => m.text).join(" ")

  const baselineKeywords = extractKeywords(state.baseline + " " + (state.currentTitle || ""))
  const recentKeywords = extractKeywords(recentUserText)

  // Overlap below 0.2 means the conversation moved to a completely different subject
  const overlap = computeOverlap(baselineKeywords, recentKeywords)
  if (overlap >= 0.2 || recentKeywords.size < 3) {
    state.lastCheckedIndex = messages.length
    return
  }

  state.isRenaming = true
  try {
    // Token titles first: no provider, no auth, instant. The model only runs
    // when the window holds fewer than three topical words.
    const extracted = buildExtractiveTitle(recentMessages)
    const newTitle = extracted ?? (await port.nameTopic(sessionID, recentUserText, recentAssistantText, true))
    if (newTitle && newTitle.toLowerCase() !== (state.currentTitle || "").toLowerCase()) {
      state.driftCount++
      // The "~ " prefix marks a title that moved off the original topic
      const fullTitle = `~ ${newTitle}`
      state.currentTitle = fullTitle
      state.lastCheckedIndex = messages.length
      await port.writeTitle(sessionID, fullTitle)
    } else {
      state.lastCheckedIndex = messages.length
    }
  } finally {
    state.isRenaming = false
  }
}

const v2Plugin = Plugin.define({
  id: "topics",
  async setup(ctx) {
    const sessions = new Map<string, SessionState>()

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
        push(normalizeModel(ctx.options?.model))
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

    const controller = new AbortController()
    const subscribe = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
            await checkSession(port, sessions, event.data.sessionID)
          } else if (event.type === "session.deleted") {
            sessions.delete(event.data.sessionID)
          }
        } catch {
          // one bad event must not break the subscription
        }
      }
    })()

    return () => {
      controller.abort()
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

async function v1Server(input: PluginInput): Promise<Hooks> {
  const { client } = input
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

      if (event.type === "session.idle") {
        await checkSession(port, sessions, sessionID)
      } else if (event.type === "session.deleted") {
        sessions.delete(sessionID)
      }
    }
  }
}

export default {
  ...v2Plugin,
  server: v1Server,
} satisfies PluginModule & ReturnType<typeof Plugin.define>
