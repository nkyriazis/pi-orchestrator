# Orchestrator Extension

Code-guided durable execution for pi. Single tool for creating, viewing, and executing orchestration scripts.

## Actions

| Action | Description |
|--------|-------------|
| `create` | Create a new orchestration with `script` (inline TypeScript) |
| `view` | View current script and execution state (default) |
| `execute` | Run the script (resumes from last completed call if already running) |
| `update` | Replace the script in place, resets execution state |
| `abort` | Pause execution |
| `restart` | Reset all calls and rerun from scratch |

## DSL

Two globals injected into the script:

| Function | Signature | Returns |
|----------|-----------|---------|
| `delegate` | `(session, agent, task)` | `Promise<string>` |
| `delegateParallel` | `(tasks, options?)` | `Promise<[session, output][]>` |

**`session`** — string key grouping calls that share context. Same session → previous outputs injected as history.

**Return value** — the assistant's final text response from the last turn. If the agent uses tools (bash, read, etc.), only the final text message is returned. Structure task prompts so the agent summarizes findings in its response.

**`delegateParallel`** — `tasks` is `[[session, agent, task], ...]`. All sessions must be unique. Use sequential `delegate()` for shared context.

## Usage Pattern

```
orchestrator({ action: "create", script: "const x = await delegate('s1', 'scout', 'Find auth code');" })
```

```
orchestrator({ action: "execute" })
```

```
orchestrator({ action: "view" })
```

```
orchestrator({ action: "update", script: "const x = await delegate('s1', 'scout', 'Find auth code');\nconst y = await delegate('s1', 'planner', 'Plan based on: ' + x);" })
```

## Agents

Delegates to agents in `~/.pi/agent/agents/*.md`.
