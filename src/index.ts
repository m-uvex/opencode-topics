import type { Plugin } from "@opencode-ai/plugin"

interface SessionState {
  initialTitle: string | null
  currentTitle: string | null
  lastCheckedIndex: number
  messageCount: number
  driftCount: number
  isRenaming: boolean
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
  return title
    .replace(/[^\w\s.\-~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

export const Topics: Plugin = async ({ client }) => {
  const sessions = new Map<string, SessionState>()

  async function getMessages(sessionId: string): Promise<Array<{ role: string; text: string }>> {
    try {
      const res = await client.session.messages({ path: { id: sessionId } }) as any
      const list = res?.data || res || []
      const out: Array<{ role: string; text: string }> = []
      for (const item of list) {
        const role = item?.info?.role || item?.role || "user"
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
  }

  async function generateTitleFromText(userSnippet: string, assistantSnippet: string, isDrift: boolean): Promise<string | null> {
    const prompt = `Summarize the topic of this conversation in 3-5 words in title case.
${isDrift ? "This conversation shifted into a new sub-topic. Summarize the NEW active focus." : ""}

User: "${userSnippet.slice(0, 300)}"
Assistant: "${assistantSnippet.slice(0, 300)}"

Rules:
- 3 to 5 words maximum
- Keep dots in filenames like package.json or file.ts
- Return ONLY the title text, nothing else.`

    let tempId: string | null = null
    try {
      const created = await client.session.create({ body: { title: "topics-eval" } }) as any
      tempId = created?.id || created?.data?.id
      if (!tempId) return null

      const res = await client.session.prompt({
        path: { id: tempId },
        body: { parts: [{ type: "text", text: prompt }] }
      }) as any

      const parts = res?.parts || res?.data?.parts || []
      for (const p of parts) {
        if (p?.type === "text" && p?.text) {
          const line = p.text.trim().split("\n")[0].trim()
          return sanitizeTitle(line)
        }
      }
    } catch {
      return null
    } finally {
      if (tempId) {
        client.session.delete({ path: { id: tempId } }).catch(() => {})
      }
    }
    return null
  }

  async function checkSession(sessionId: string, forceCheck = false) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        initialTitle: null,
        currentTitle: null,
        lastCheckedIndex: 0,
        messageCount: 0,
        driftCount: 0,
        isRenaming: false,
      }
      sessions.set(sessionId, state)
    }

    if (state.isRenaming) return

    const messages = await getMessages(sessionId)
    if (messages.length === 0) return

    state.messageCount = messages.length

    // Initial naming on first exchange
    if (!state.initialTitle) {
      const userFirst = messages.find(m => m.role === "user")?.text || ""
      const assistantFirst = messages.find(m => m.role === "assistant")?.text || ""
      if (userFirst) {
        state.isRenaming = true
        try {
          const title = await generateTitleFromText(userFirst, assistantFirst, false)
          if (title) {
            state.initialTitle = title
            state.currentTitle = title
            state.lastCheckedIndex = messages.length
            await client.session.update({ path: { id: sessionId }, body: { title } })
          }
        } finally {
          state.isRenaming = false
        }
      }
      return
    }

    // Check every message
    const diff = messages.length - state.lastCheckedIndex
    if (!forceCheck && diff < 1) {
      return
    }

    // Local, tokenless keyword drift check
    const recentMessages = messages.slice(-4)
    const recentUserText = recentMessages.filter(m => m.role === "user").map(m => m.text).join(" ")
    const recentAssistantText = recentMessages.filter(m => m.role === "assistant").map(m => m.text).join(" ")

    const titleKeywords = extractKeywords(state.initialTitle + " " + (state.currentTitle || ""))
    const recentKeywords = extractKeywords(recentUserText)

    const overlap = computeOverlap(titleKeywords, recentKeywords)

    // Overlap < 0.2 indicates the conversation moved to a completely different subject
    if (overlap < 0.2 && recentKeywords.size >= 3) {
      state.isRenaming = true
      try {
        const newTitle = await generateTitleFromText(recentUserText, recentAssistantText, true)
        if (newTitle && newTitle.toLowerCase() !== state.currentTitle?.toLowerCase()) {
          state.driftCount++
          // Subtle marker "~ " indicating topic shifted from original
          const fullTitle = `~ ${newTitle}`
          state.currentTitle = fullTitle
          state.lastCheckedIndex = messages.length
          await client.session.update({ path: { id: sessionId }, body: { title: fullTitle } })
        }
      } finally {
        state.isRenaming = false
      }
    } else {
      state.lastCheckedIndex = messages.length
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      const type = event?.type
      const sessionId =
        event?.properties?.sessionID ||
        event?.properties?.session?.id ||
        event?.properties?.part?.sessionID ||
        event?.sessionID ||
        null

      if (!sessionId) return

      if (type === "session.idle") {
        await checkSession(sessionId, false)
      } else if (type === "session.deleted") {
        sessions.delete(sessionId)
      }
    }
  }
}

export default Topics
