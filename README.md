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
* **Customizable indicators:** Subtle `~` prefix by default, or count how many times the topic drifted like `(1) Title` -> `(2) Title`, or turn prefixes off completely.
* **Zero extra cost:** Reads your messages locally using smart text patterns. It doesn't ping an AI model on every turn, saving your tokens and your money.
* **Understands session history:** If you undo, rewind, or compact a long chat into a summary, your title stays in sync with what is currently on screen.

---

## Installation

Works on both OpenCode v1 and v2.

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
Add the plugin to your global config (`~/.config/opencode/opencode.jsonc`) or local `opencode.json`. You can use it as a simple string or pass custom options:

```jsonc
{
  "plugins": [
    "github:m-uvex/opencode-topics",
  ]
}
```

---

## Configuration

Everything works out of the box with zero setup, but all behavior is fully customizable:

```jsonc
{
  "plugins": [
    [
      "github:m-uvex/opencode-topics",
      {
        // Visual indicator added to the start of retitled sessions.
        // Default is "~". Use "<count>" to track drifts, e.g. "(<count>)" -> "(1) Title", "(2) Title".
        // Set to "" to disable prefixes completely.
        "prefix": "~",
      
        // Title format for drifted sessions:
        // - "project:task" (default) -> "~ Project: Current Sub-Task"
        // - "task"                   -> "~ Current Sub-Task"
        // - "project"                -> "~ Project"
        "structure": "project:task",
      
        // How titles are generated:
        // - "hybrid" (default): fast local extraction, model fallback if too short
        // - "algorithm": 100% local, zero tokens, never touches a model
        // - "ai": always uses the model
        "titlesBy": "hybrid",
      
        // Check for topic drift every N messages (1-20, default: 1)
        "checkEvery": 1,
      
        // How many recent user turns define the current topic window (1-5, default: 1)
        "windowTurns": 1,
      
        // Topic overlap ratio required to stay on topic (0.05-1.0, default: 0.2)
        "threshold": 0.2,
      
        // Consecutive off-topic turns required before renaming (1-5, default: 2)
        "confirmations": 2,
      
        // Which session events trigger checks (default: all included)
        "on": ["message", "compaction", "undo", "redo", "fork", "rename"],
      
        // Model override for the AI fallback (optional, defaults to your active session model)
        "model": {
          "providerID": "google",
          "id": "gemini-3.8-flash"
        }
      }
    ]
  ]
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
* **Context & Umbrellas:** Project-anchored titles (`~ Project: Current Task`), customizable counting prefixes, and clean stop-word filtering.

---

## License

MIT
