# opencode-topics

> Session titles that evolve as your conversation moves.

A smart re-titling plugin for [OpenCode](https://opencode.ai). When a quick question turns into an hour-long debugging marathon, `opencode-topics` keeps your sidebar accurate so you can always find your work later.

---

## Why You Need This

Most chat tools name your session on the first message and never touch it again. 

You start by asking *"How do I install Docker?"*, but twenty minutes later you're deep into setting up an OAuth server. Later on, you're scanning your session list looking for your OAuth work, and all you see is *"How do I install Docker"*.

`opencode-topics` quietly tracks what you are actually working on and updates the title when the topic shifts, without getting in your way or burning through your AI limits.

---

## What It Does

* **Follows the conversation:** Recognizes when you have genuinely moved on to something new and re-titles the session automatically.
* **Keeps the big picture:** Sub-tasks stay anchored to your main project instead of losing context. Setting up an auth client inside your Immich session becomes `~ Immich: Authelia OAuth Client`.
* **Subtle visual cue:** Any re-titled session gets a gentle `~` prefix, so you can tell at a glance that the conversation branched out from where it started.
* **Zero extra cost:** Reads your messages locally using smart text patterns. It doesn't ping an AI model on every turn, saving your tokens and your money.
* **Understands session history:** If you undo, rewind, or compact a long chat into a summary, your title stays in sync with what is currently on screen.

---

## Installation

Works seamlessly on both OpenCode v1 and v2.

### Option 1: Just ask OpenCode (easiest)
Paste this into your active session:
```text
Install the plugin m-uvex/opencode-topics from github.
```

### Option 2: Using the CLI
Run this in your terminal:
```bash
opencode plugin add github:m-uvex/opencode-topics
```

### Option 3: Add to your config
Add this to your global config (`~/.config/opencode/opencode.jsonc`) or local `opencode.json`:
```json
{
  "plugins": ["github:m-uvex/opencode-topics"]
}
```

---

## Roadmap

```text
──●──────────────────●──────────────────●──────────────────●──────────────────●
  Initial Release      Tokenless Titles   OpenCode V2        Granular Config    Context & Umbrellas
  smart auto-titling   runs locally       dual engine        custom cadence     anchor to project,
  for v1 chats         zero token cost    v1 + v2 support    & trigger events   clean filler words
```

* **Initial Release:** Automatic session titling for OpenCode v1.
* **Tokenless Titles:** Local keyword analysis that detects shifts and generates titles without burning AI tokens.
* **OpenCode V2 Support:** Built for the new v2 plugin engine while keeping full v1 backward compatibility.
* **Granular Configuration:** Fine-tune how often checks run, what events trigger them, and whether to use the local algorithm or an AI model.
* **Context & Umbrellas:** Project-anchored titles (`~ Project: Current Task`) and a refined vocabulary filter that ignores filler words.

---

## License

MIT
