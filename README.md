# opencode-topics

Adaptive, token-efficient session re-titling plugin for [OpenCode](https://opencode.ai).
Tracks topic drift over long conversations and updates session titles dynamically so you never lose context.

## Why

Most autotitle plugins name a session once on turn 1 and lock it. When a session drifts to another task 20 messages later, the title in your session list stays stuck on the original task.

`opencode-topics`:
1. Names the session on the initial prompt
2. Runs a zero-token local keyword overlap check on every new message
3. When drift is detected, calls in your agent to rename the session to match the new topic
4. Marks drifted sessions with a subtle prefix (`~ Title`) so you know the topic changed from the original.

It only calls in the AI agent when a topic drift is detected, so when the topic stays the same it doesn't burn through your tokens.

## Installation

Add to your OpenCode config (`~/.config/opencode/opencode.json` or `opencode.jsonc`):

```json
{
  "plugin": ["opencode-topic-namer"]
}
```

## License
MIT
