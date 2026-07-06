# pi-orchestrator

Code-guided durable execution for the [pi coding agent](https://pi.dev).

Single tool for creating, viewing, and executing TypeScript orchestration scripts that delegate work to specialized subagents.

## Install

```bash
pi install npm:@kyriazis/pi-orchestrator
```

## Usage

The orchestrator exposes a single `orchestrator` tool that accepts actions:

| Action | Description |
|--------|-------------|
| `create` | Create a new orchestration with `script` (inline TypeScript) |
| `view` | View current script and execution state (default) |
| `execute` | Run the script (resumes from last completed call if already running) |
| `update` | Replace the script in place, resets execution state |
| `abort` | Pause execution |
| `restart` | Reset all calls and rerun from scratch |

### Script DSL

Two globals are injected into your script:

```typescript
delegate(session, agent, task)          → run a subagent, returns text
delegateParallel(tasks, options?)        → run independent subagents in parallel
consoleLog(...args)                      → log output visible in results
finish(result)                           → declare the final output
```

**`session`** — string key grouping calls that share context. Same session → previous outputs injected as history.

### Example

```typescript
const auth = await delegate('research', 'scout', 'Find all auth code');
const plan = await delegate('plan', 'planner', 'Plan OAuth integration based on: ' + auth);
finish('Authentication audit complete. Findings: ' + plan);
```

## Agents

Delegates to agents defined in `~/.pi/agent/agents/*.md` (user scope).

Agent files use YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
---

You are a scout. Quickly investigate a codebase...
```

## Workflow

1. **Create** the orchestration script (`action: "create"`)
2. **Review** with the user (`action: "view"`)
3. **Execute** after approval (`action: "execute"`)
4. Call `finish(result)` at the end of the script for a final summary

## License

MIT
