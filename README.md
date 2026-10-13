# opencode-topics

Adaptive, token-efficient session re-titling plugin for [OpenCode](https://opencode.ai). 

Tracks topic drift over long conversations and dynamically updates session titles so you never lose context in your session history.

## The Problem
Most auto-title plugins name a session on the first turn and lock it. When a conversation drifts to a completely different task 20 messages later, your session list stays stuck on the original prompt, making it difficult to find what you were actually working on.

## How It Works
`opencode-topics` solves this by continuously monitoring your session without eating into your API limits:

* **Initial Naming:** Generates a title based on your very first prompt.
(Note: in v2 this is taken care of by opencode itself as opposed to the plugin.)
* **Zero-Token Tracking:** Runs a local keyword overlap check on every new message to detect topic drift.
* **Dynamic Re-Titling:** Uses a fast, tokenless algorithm to generate a fitting new title based on the recent message history.
* **Visual Indicators:** Marks drifted sessions with a subtle prefix (`~ Title`) so you instantly know the topic has evolved from the original prompt.
* **Economical Fallback:** Fully local by default. The running AI model is only triggered as a rare fallback if the locally generated title is detected to be too short.

## Installation
*Fully supports both OpenCode v1 and v2.*

### Option 1: Let the AI do it
Simply open up an OpenCode session and send this prompt:
```text
Install the plugin m-uvex/opencode-topics from github.
```

### Option 2: Using the CLI
Open your terminal and run:
```bash
opencode plugin add github:m-uvex/opencode-topics
```

### Option 3: Manual Configuration
Add the plugin to the top of your global config (~/.config/opencode/opencode.jsonc) or your project's local opencode.json:
```json
{
  "plugins": ["github:m-uvex/opencode-topics"]
}
```

## License
MIT

