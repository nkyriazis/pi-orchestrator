# pi-orchestrator

Code-guided durable execution for the [pi coding agent](https://pi.dev).

Has the agent ever promised it prompted a subagent "with a clear, detailed instruction" — but when you expanded the tool call, the actual prompt was vague, incomplete, or just wrong?

That's the problem this solves. Instead of the LLM describing subagent prompts in prose, **you write real TypeScript**. The orchestrator executes it literally — no paraphrasing, no hallucination, no lossy translation.

## What it does

A single tool that lets the agent:

1. **Write** a TypeScript script using `delegate()` and `delegateParallel()`
2. **Show** you the script for review
3. **Execute** it — line by line, with live progress tracking

What you see in the script is exactly what runs.

## Install

```bash
pi install npm:@nkyriazis/pi-orchestrator
```

## Example

The agent creates a script:

```typescript
const findings = await delegate(
  'audit',
  'scout',
  'Find all authentication code and summarize the auth flow',
);

const plan = await delegate(
  'audit',
  'planner',
  'Based on these findings, plan an OAuth migration:\n' + findings,
);

finish('Auth audit complete.\n\n' + plan);
```

You review it with `view`, approve with `execute`, and watch it run — each `delegate()` call streaming progress as it goes.

## The DSL

Four globals injected into your script:

| Global | Purpose |
|--------|---------|
| `delegate(session, agent, task)` | Run a subagent. Same `session` key shares history across calls. |
| `delegateParallel(tasks, options?)` | Run independent subagents concurrently. |
| `consoleLog(...args)` | Log output visible in results. |
| `finish(result)` | Declare the final output — surfaced prominently when execution ends. |

### Sequential with shared context

```typescript
// Same session ("research") — second call sees the first call's output
const api = await delegate('research', 'scout', 'Find the API entry points');
const deps = await delegate('research', 'scout', 'Now find the dependencies those entry points import');
finish('API surface mapped. Entry points and deps documented above.');
```

### Parallel independent calls

```typescript
const results = await delegateParallel([
  ['models', 'scout', 'Find all model definitions and their interfaces'],
  ['providers', 'scout', 'Find all provider implementations and their config'],
], { maxConcurrency: 2 });

const [modelsOutput, providersOutput] = results.map(([_, output]) => output);
finish('Models and providers analyzed in parallel.');
```

### Multi-step pipeline

```typescript
const code = await delegate('review', 'scout',
  'Find the error handling patterns in the codebase');

const assessment = await delegate('review', 'reviewer',
  'Critique the error handling. What is missing? ' + code);

const improved = await delegate('review', 'worker',
  'Implement the improvements suggested: ' + assessment);

finish('Error handling review and improvements complete.');
```

## Workflow

The orchestrator enforces a review step:

| Step | Action | What happens |
|------|--------|-------------|
| 1 | `create` | Script is stored, not executed |
| 2 | `view` | You see the script and plan |
| 3 | `execute` | Script runs after you approve |
| 4 | `update` | Modify mid-flight if needed |

This means the agent **cannot** create and run a script in one turn. You always see the plan first.

## Live tracking

While executing, a widget above the editor shows:

- Each delegate call's status (⏳ running, ✓ done, ✗ error)
- Current tool the subagent is executing
- Timing per call
- Console output tail

## Agents

Delegates to agents defined in `~/.pi/agent/agents/*.md`. Agent files use YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
---

You are a scout. Quickly investigate a codebase and return structured findings.
```

## API reference

| Action | Description |
|--------|-------------|
| `create` | Create a new orchestration. Requires `script` parameter. |
| `view` | View current script and execution state. Default action. |
| `execute` | Run the script. Resumes from last completed call if interrupted. |
| `update` | Replace the script in place. Resets execution state. |
| `abort` | Pause execution. |
| `restart` | Reset all calls and rerun from scratch. |

## Why "orchestrator" and not "subagent"?

The built-in `subagent` tool sends a natural language description to the LLM, which then constructs the prompt. The orchestrator sends **code** — the prompt is the code itself, executed verbatim. Less indirection, more trust.

## License

MIT
