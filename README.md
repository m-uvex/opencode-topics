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

One package works on both OpenCode generations: it exports the V2 plugin and the V1
`server` hook, and OpenCode uses whichever it understands. Only the config key differs.

### OpenCode 2.x

Using the CLI:

```bash
opencode plugin add github:m-uvex/opencode-topics
```

Or add it to your config (`~/.config/opencode/opencode.jsonc` or the project's
`opencode.json`):

```jsonc
{
  "plugins": ["github:m-uvex/opencode-topics"]
}
```

Titles are generated with the session's model. OpenCode rejects its free-tier models
for plugin calls, so pin a model if your sessions run on one:

```jsonc
{
  "plugins": [
    {
      "package": "github:m-uvex/opencode-topics",
      "options": {
        "model": { "providerID": "google", "id": "gemini-flash-latest" }
      }
    }
  ]
}
```

### OpenCode 1.x

Using the CLI:

```bash
opencode plugin add github:m-uvex/opencode-topics
```

Or add it to your config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["github:m-uvex/opencode-topics"]
}
```

### Local checkout

To test an unpushed checkout, drop a plugin file that re-exports it. OpenCode
discovers `.ts` files in `~/.config/opencode/plugins/` (global) and
`.opencode/plugins/` (project):

```ts
// ~/.config/opencode/plugins/topics.ts
export { default } from "/absolute/path/to/opencode-topics/src/index.ts"
```

## License
MIT
