/**
 * Orchestrator — Code-Guided Durable Execution
 *
 * Single tool for creating, viewing, and executing orchestration scripts.
 * The LLM writes TypeScript that coordinates subagent delegation via delegate().
 *
 * DSL (injected as globals in the script):
 *   delegate(session, agent, task)          → run a subagent, returns text
 *   delegateParallel(tasks, options?)        → run independent subagents in parallel
 *
 * Actions: create, view, execute, update, abort, restart
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getModel, StringEnum, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";

// ─── State ──────────────────────────────────────────────────────────────────

interface OrchestratorState {
  script: string;
  delegateCalls: DelegateCallRecord[];
  currentCall: number;
  variables: Record<string, any>;
  sessionHistory: Record<string, string[]>;
  startedAt?: number;
  status: "draft" | "running" | "paused" | "completed" | "error";
  errorMessage?: string;
  consoleLogs: string[];
  currentLine?: number;
  scriptLines?: string[];
  finalResult?: string; // set by finish() in the script
}

interface DelegateCallRecord {
  label?: string;
  index: number;
  agent: string;
  session: string;
  task: string;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  outputPreview?: string;
  durationMs?: number;
  currentStep?: string; // e.g. tool name currently executing
}


function resolveModelFromAgent(modelStr: string, fallbackModel: Model<any>): Model<any> {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx > 0) {
    const provider = modelStr.slice(0, slashIdx) as any;
    const modelId = modelStr.slice(slashIdx + 1) as any;
    try {
      const found = getModel(provider, modelId);
      if (found) return found;
    } catch {}
  }

  for (const provider of ["anthropic", "openai", "google", "groq"] as any[]) {
    try {
      const found = getModel(provider, modelStr as any);
      if (found) return found;
    } catch {}
  }

  return fallbackModel;
}


async function runDelegateSdk(
  agent: AgentConfig,
  task: string,
  sessionHistory: string[],
  modelRegistry: ModelRegistry,
  fallbackModel: Model<any>,
  cwd: string,
  signal: AbortSignal | undefined,
  onStep?: (step: string) => void,
): Promise<{ output: string }> {
  // Try agent's model first, then fallback to ctx's model
  let model: Model<any>;
  if (agent.model) {
    const resolved = resolveModelFromAgent(agent.model, fallbackModel);
    if (modelRegistry.hasConfiguredAuth(resolved)) {
      model = resolved;
    } else {
      model = fallbackModel;
    }
  } else {
    model = fallbackModel;
  }

  let systemPrompt = agent.systemPrompt.trim();
  if (sessionHistory.length > 0) {
    systemPrompt += `\n\n## Session History (previous outputs in this session)\n`;
    for (let i = 0; i < sessionHistory.length; i++) {
      systemPrompt += `\n### Step ${i + 1}\n${sessionHistory[i]}\n`;
    }
  }

  const tools = agent.tools && agent.tools.length > 0 ? [...agent.tools] : ["read", "bash", "grep", "find", "ls"];

  const { session } = await createAgentSession({
    model,
    tools,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    cwd,
  });

  session.agent.state.systemPrompt = systemPrompt;

  if (signal) {
    if (signal.aborted) { session.dispose(); throw new Error("Aborted"); }
    signal.addEventListener(
      "abort",
      () => { session.abort(); session.dispose(); },
      { once: true },
    );
  }

  let lastAssistantText = "";
  session.subscribe((event) => {
    if (event.type === "message_update") {
      const amEvent = event as any;
      if (amEvent.assistantMessageEvent?.type === "text_delta") {
        lastAssistantText += amEvent.assistantMessageEvent.delta;
      }
    }
    if (onStep) {
      if (event.type === "tool_execution_start") {
        onStep((event as any).toolName);
      } else if (event.type === "tool_execution_end") {
        onStep("thinking");
      }
    }
  });

  await session.prompt(task);
  session.dispose();

  return { output: lastAssistantText.trim() || "(no output)" };
}

// ─── Line Tracking (generic cursor tracking via source transformation) ────

/**
 * Inject `await __trackLine(n)` before each statement in the script.
 *
 * Because the script runs as an async function inside `new Function()`, we
 * can't hook into V8's interpreter. Instead we transform the source: every
 * top-level statement is preceded by `await __trackLine(N)` where N is the
 * **original** 0-based line number. Since the script is already async, every
 * `await` yields control back to our runtime, letting us update currentLine
 * accurately before each statement executes.
 *
 * Multi-line statements are tracked once on their first line.
 * Template literals, comments, and blank lines are skipped.
 *
 * Returns both the transformed script and a reverse mapping so the debug
 * panel can map transformed line numbers back to original lines.
 */
function injectLineTracking(scriptContent: string): {
  trackedScript: string;
  /** Given a line index in the transformed script, returns the original line index, or undefined if it's an injected line. */
  transformToOriginal: (transformedLineIdx: number) => number | undefined;
} {
  const lines = scriptContent.split('\n');
  const tracked: string[] = [];
  // Maps each line index in the *transformed* script → original line index
  const lineMap: number[] = [];
  let i = 0;

  // Tokens that clearly start a statement
  const keywordRe = /^(\s*)(const|let|var|async|function|return|if|for|while|switch|try|class|export|import|throw|do|with|new|delete|typeof|void|in|of|\bdebugger\b)/;
  // A line that starts with an identifier/function-call (expression statement)
  const exprRe = /^[\s]*[a-zA-Z_$@]/;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blank lines and comment-only lines
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      tracked.push(line);
      lineMap.push(i);
      i++;
      continue;
    }

    // Multi-line template literal: consume until closing backtick
    // Detect: line contains an odd number of unescaped backticks
    const backtickCount = (line.match(/`/g) || []).length;
    if (backtickCount % 2 !== 0) {
      // Odd number — we're entering or inside a multi-line template
      tracked.push(`await __trackLine(${i});`);
      lineMap.push(i); // injected line → maps to original
      tracked.push(line);
      lineMap.push(i);
      i++;
      while (i < lines.length) {
        tracked.push(lines[i]);
        lineMap.push(i);
        if ((lines[i].match(/`/g) || []).length % 2 !== 0) break;
        i++;
      }
      i++;
      continue;
    }

    // Closing brace only — not a statement boundary
    if (trimmed === '}' || trimmed.startsWith('})') || trimmed.startsWith('},')) {
      tracked.push(line);
      lineMap.push(i);
      i++;
      continue;
    }

    // Opening brace only on its own line — not a statement, it's a block
    if (trimmed === '{') {
      tracked.push(line);
      lineMap.push(i);
      i++;
      continue;
    }

    // `else` on its own or `else {` — attach to the if, not a new statement
    if (trimmed.startsWith('else') && !keywordRe.test(line.replace(/^\s*else\s*/, ''))) {
      tracked.push(line);
      lineMap.push(i);
      i++;
      continue;
    }

    // Catch clauses: `catch` / `catch(` / `catch (err)`
    if (trimmed.startsWith('catch')) {
      tracked.push(line);
      lineMap.push(i);
      i++;
      continue;
    }

    // Finally
    if (trimmed === 'finally') {
      tracked.push(line);
      lineMap.push(i);
      i++;
      continue;
    }

    // This line starts a real statement
    const isStatement = keywordRe.test(line) ||
      (exprRe.test(line) && !trimmed.startsWith('case ') && !trimmed.startsWith('default:'));

    if (isStatement) {
      tracked.push(`await __trackLine(${i});`);
      lineMap.push(i); // injected line maps to the original line it precedes
    }

    tracked.push(line);
    lineMap.push(i);
    i++;
  }

  return {
    trackedScript: tracked.join('\n'),
    transformToOriginal: (idx: number) => lineMap[idx] ?? undefined,
  };
}

// ─── Step Parsing ───────────────────────────────────────────────────────────

function parseDelegateCalls(scriptContent: string): DelegateCallRecord[] {
  const calls: DelegateCallRecord[] = [];
  const pattern = /\b(delegate|delegateParallel)\s*\(/g;
  let match;
  let index = 0;

  while ((match = pattern.exec(scriptContent)) !== null) {
    const lineStart = scriptContent.lastIndexOf("\n", match.index - 1) + 1;
    const lineEnd = scriptContent.indexOf("\n", match.index);
    const line = scriptContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const commentMatch = line.match(/\/\/\s*@\s*([\w-]+)/);

    calls.push({
      index: index++,
      agent: "?",
      session: "?",
      task: "?",
      status: "pending",
      label: commentMatch?.[1],
    });
  }
  return calls;
}

// ─── Formatter ──────────────────────────────────────────────────────────────

function formatView(state: OrchestratorState): string {
  const lines: string[] = [];
  const completed = state.delegateCalls.filter((s) => s.status === "completed").length;
  const total = state.delegateCalls.length;

  lines.push(`## Orchestrator`);
  lines.push(`Status: ${state.status}`);
  if (total > 0) lines.push(`Progress: ${completed}/${total} delegate calls`);
  if (state.finalResult) {
    lines.push(`\n### Result\n${state.finalResult}`);
  }
  lines.push("");

  lines.push("### Script");
  lines.push("```typescript");
  // Syntax-highlight each line for better readability
  const scriptLines = state.script.split('\n');
  for (const line of scriptLines) {
    const highlighted = highlightCode(line, 'typescript');
    lines.push(highlighted[0] ?? line);
  }
  lines.push("```");

  if (total > 0) {
    lines.push("\n### Delegate Calls");
    for (const call of state.delegateCalls) {
      const icon = call.status === "completed" ? "✓" : call.status === "error" ? "✗" : call.status === "running" ? "⏳" : "○";
      const label = call.label ? ` (${call.label})` : "";
      const sessionInfo = call.session !== "?" ? `[${call.session}]` : "";
      lines.push(`- ${icon} Call ${call.index + 1}${label}: ${call.agent}${sessionInfo} → ${call.status}`);
      if (call.error) lines.push(`  Error: ${call.error}`);
      if (call.durationMs != null) lines.push(`  Duration: ${call.durationMs}ms`);
      if (call.outputPreview && call.status === "completed") {
        const preview = call.outputPreview.length > 80
          ? call.outputPreview.slice(0, 80) + "..."
          : call.outputPreview;
        lines.push(`  Output: ${preview}`);
      }
    }
  }

  if (state.errorMessage) lines.push(`\n**Error:** ${state.errorMessage}`);

  if (state.consoleLogs && state.consoleLogs.length > 0) {
    lines.push(`\n### Console Output`);
    for (const log of state.consoleLogs.slice(-20)) {
      lines.push(`> ${log}`);
    }
  }

  const sessions = Object.keys(state.sessionHistory);
  if (sessions.length > 1) {
    lines.push(`\n### Sessions (${sessions.length})`);
    for (const [name, history] of Object.entries(state.sessionHistory)) {
      lines.push(`- \`${name}\`: ${history.length} accumulated output(s)`);
    }
  }

  return lines.join("\n");
}

function formatExecuteSummary(state: OrchestratorState): string {
  const completed = state.delegateCalls.filter((s) => s.status === "completed").length;
  const total = state.delegateCalls.length;
  const lines: string[] = [];
  lines.push(`## Orchestrator`);
  lines.push(`Status: ${state.status} | ${completed}/${total} delegate calls`);
  if (state.errorMessage) lines.push(`\n**Error:** ${state.errorMessage}`);

  // Final result declared by the script via finish()
  if (state.finalResult) {
    lines.push(`\n### Result\n${state.finalResult}`);
  }

  if (total > 0) {
    lines.push("\n### Delegate Calls");
    for (const call of state.delegateCalls) {
      const icon = call.status === "completed" ? "✓" : call.status === "error" ? "✗" : call.status === "running" ? "⏳" : "○";
      const label = call.label ? ` (${call.label})` : "";
      const sessionInfo = call.session !== "?" ? `[${call.session}]` : "";
      const timing = call.durationMs != null ? ` (${call.durationMs}ms)` : "";
      lines.push(`- ${icon} Call ${call.index + 1}${label}: ${call.agent}${sessionInfo} → ${call.status}${timing}`);
      if (call.error) lines.push(`  Error: ${call.error}`);
      if (call.outputPreview) {
        const preview = call.outputPreview.length > 80
          ? call.outputPreview.slice(0, 80) + "..."
          : call.outputPreview;
        lines.push(`  Output: ${preview}`);
      }
    }
  }
  if (state.consoleLogs && state.consoleLogs.length > 0) {
    lines.push("\n### Console Output");
    for (const log of state.consoleLogs.slice(-10)) {
      lines.push(`> ${log}`);
    }
  }
  return lines.join("\n");
}

// ─── Widget-based debug display (renders above editor, no overlay) ────

const ORCHESTRATOR_WIDGET_KEY = "orchestrator-debug";

function setupOrchestratorWidget(
  ctx: ExtensionContext,
  stateRef: OrchestratorState,
): () => void {
  if (!ctx.hasUI) return () => {};

  const { theme } = ctx.ui;
  let spinnerFrame = 0;
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  const renderWidget = () => {
    const state = stateRef;
    const w = process.stdout.columns || 120;
    const lines: string[] = [];
    const maxLines = 10; // pi core hard limit (InteractiveMode.MAX_WIDGET_LINES)

    const completed = state.delegateCalls.filter((c) => c.status === "completed").length;
    const running = state.delegateCalls.filter((c) => c.status === "running").length;

    // Header
    lines.push(theme.fg("accent", theme.bold(`▸ Orchestrator: ${state.status} | ${completed} done | ${running} running | ${state.delegateCalls.length} total`)));

    // Call status — running calls first, then completed, then pending
    spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
    const sorted = [...state.delegateCalls].sort((a, b) => {
      const order = { running: 0, error: 1, completed: 2, pending: 3 };
      return (order[a.status] ?? 4) - (order[b.status] ?? 4);
    });

    for (const call of sorted) {
      if (lines.length >= maxLines - 1) break; // leave room for console
      const icon =
        call.status === "completed" ? "✓" :
        call.status === "error" ? "✗" :
        call.status === "running" ? spinnerFrames[spinnerFrame] : "○";
      const color =
        call.status === "completed" ? "success" :
        call.status === "error" ? "error" :
        call.status === "running" ? "warning" : "muted";
      const timing = call.durationMs != null ? ` (${call.durationMs}ms)` : "";
      const sessionInfo = call.session !== "?" ? `[${call.session}]` : "";
      const stepInfo = call.currentStep && call.status === "running"
        ? ` → ${call.currentStep}`
        : "";
      lines.push(theme.fg(color, `   ${icon} ${call.agent}${sessionInfo}${timing}${stepInfo}`));
    }

    // Final result (last line) or console tail
    if (lines.length < maxLines && state.finalResult) {
      const truncated = state.finalResult.length > w - 6 ? state.finalResult.slice(0, w - 6) + "…" : state.finalResult;
      lines.push(theme.fg("success", `  ✓ ${truncated}`));
    } else if (lines.length < maxLines && state.consoleLogs && state.consoleLogs.length > 0) {
      const lastLog = state.consoleLogs[state.consoleLogs.length - 1];
      const truncated = lastLog.length > w - 6 ? lastLog.slice(0, w - 6) + "…" : lastLog;
      lines.push(theme.fg("muted", `  > ${truncated}`));
    }

    ctx.ui.setWidget(ORCHESTRATOR_WIDGET_KEY, lines.slice(0, maxLines));
  };

  renderWidget();

  return () => {
    ctx.ui.setWidget(ORCHESTRATOR_WIDGET_KEY, undefined);
  };
}

// ─── Orchestrator Runner ────────────────────────────────────────────────────

async function executeOrchestration(
  state: OrchestratorState,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<OrchestratorState>) => void) | undefined,
  onRender?: () => void,
): Promise<OrchestratorState> {
  const scriptContent = state.script;
  const cwd = ctx.cwd;
  const agents = discoverAgents(cwd, "user").agents;

  // Initialize runtime tracking
  state.consoleLogs = state.consoleLogs || [];
  state.scriptLines = state.scriptLines || scriptContent.split('\n');

  state.status = "running";
  state.startedAt = Date.now();

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: formatExecuteSummary(state) }],
        details: state,
      });
    }
    onRender?.();
  };

  const delegate = async (
    session: string,
    agent: string,
    task: string,
  ): Promise<string> => {
    const idx = state.delegateCalls.length;

    // Runtime slot allocation — works for loops, conditionals, dynamic calls
    const record: DelegateCallRecord = {
      index: idx,
      agent,
      session,
      task,
      status: "running",
      startedAt: Date.now(),
    };
    state.delegateCalls.push(record);

    // currentLine is already tracked by __trackLine injection before this statement
    state.status = "running";
    emitUpdate();

    const agentConfig = agents.find((a) => a.name === agent);
    if (!agentConfig) {
      const available = agents.map((a) => a.name).join(", ") || "none";
      const errMsg = `Unknown agent "${agent}". Available: ${available}`;
      record.status = "error";
      record.error = errMsg;
      record.completedAt = Date.now();
      state.status = "error";
      state.errorMessage = errMsg;
      emitUpdate();
      throw new Error(errMsg);
    }

    const history = state.sessionHistory[session] || [];

    const result = await runDelegateSdk(
      agentConfig, task, history, ctx.modelRegistry, ctx.model, cwd, signal,
      (step) => { record.currentStep = step; emitUpdate(); },
    );

    record.currentStep = undefined;
    record.status = "completed";
    record.result = result.output;
    record.completedAt = Date.now();
    record.durationMs = Date.now() - (record.startedAt || Date.now());
    record.outputPreview = result.output.slice(0, 200);
    state.sessionHistory[session] = [...history, result.output];
    emitUpdate();
    return result.output;
  };

  const delegateParallel = async (
    tasks: Array<[session: string, agent: string, task: string]>,
    options?: { maxConcurrency?: number },
  ): Promise<Array<[session: string, output: any]>> => {
    const sessions = new Set(tasks.map(([s]) => s));
    if (sessions.size !== tasks.length) {
      const duplicates = tasks.map(([s]) => s).filter((s, i) => tasks.map(([sess]) => sess).indexOf(s) !== i);
      throw new Error(
        `delegateParallel: duplicate session names (${[...new Set(duplicates)].join(", ")}). ` +
        `Use sequential delegate() for shared context.`,
      );
    }

    const maxConcurrency = options?.maxConcurrency ?? 4;
    const startIdx = state.delegateCalls.length;

    // Runtime slot allocation for parallel tasks
    for (let i = 0; i < tasks.length; i++) {
      const [s, a, t] = tasks[i];
      state.delegateCalls.push({
        index: startIdx + i,
        agent: a,
        session: s,
        task: t,
        status: "running",
        startedAt: Date.now(),
      });
    }
    state.status = "running";
    emitUpdate();

    const results: Array<[string, string]> = [];
    let hadError = false;
    let firstError = "";

    for (let batch = 0; batch < tasks.length; batch += maxConcurrency) {
      const batchTasks = tasks.slice(batch, batch + maxConcurrency);
      const batchResults = await Promise.all(
        batchTasks.map(async ([session, agent, task], idx) => {
          const agentConfig = agents.find((a) => a.name === agent);
          if (!agentConfig) {
            return { agent, error: `Unknown agent "${agent}"`, output: "" };
          }
          const history = state.sessionHistory[session] || [];
          const globalIdx = batch + idx;
          const callRecord = state.delegateCalls[startIdx + globalIdx];
          const result = await runDelegateSdk(
            agentConfig, task, history, ctx.modelRegistry, ctx.model, cwd, signal,
            (step) => { if (callRecord) { callRecord.currentStep = step; emitUpdate(); } },
          );
          return { agent, error: undefined, output: result.output };
        }),
      );

      for (let i = 0; i < batchTasks.length; i++) {
        const [session] = batchTasks[i];
        const r = batchResults[i];
        const globalIdx = batch + i;
        const success = !r.error;

        const callRecord = state.delegateCalls[startIdx + globalIdx];
        if (callRecord) {
          if (!success) {
            callRecord.status = "error";
            callRecord.error = r.error;
            callRecord.completedAt = Date.now();
            callRecord.currentStep = undefined;
          } else {
            callRecord.status = "completed";
            callRecord.result = r.output;
            callRecord.completedAt = Date.now();
            callRecord.durationMs = Date.now() - (callRecord.startedAt || Date.now());
            callRecord.outputPreview = r.output.slice(0, 200);
            callRecord.currentStep = undefined;
          }
        }

        if (success) {
          state.sessionHistory[session] = [...(state.sessionHistory[session] || []), r.output];
          results.push([session, r.output]);
        } else {
          hadError = true;
          if (!firstError) firstError = `${r.agent}: ${r.error}`;
        }
      }
      emitUpdate();
    }

    if (hadError) {
      state.status = "error";
      state.errorMessage = firstError;
      emitUpdate();
      throw new Error(`delegateParallel failed: ${firstError}`);
    }
    emitUpdate();
    return results;
  };

  // ── Intercept console.log ──
  const originalConsoleLog = console.log;
  const consoleLogBuffer: string[] = [...state.consoleLogs];
  const consoleLogFn = (...args: any[]) => {
    const line = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
    if (line.length > 0) {
      consoleLogBuffer.push(line);
      if (consoleLogBuffer.length > 500) consoleLogBuffer.splice(0, consoleLogBuffer.length - 500);
    }
    originalConsoleLog(...args);
    emitUpdate();
  };
  console.log = consoleLogFn as any;

  // ── Execute the script with line tracking ──
  // finish(result) — lets the script declare a final summary string
  const finishFn = (result: string) => {
    state.finalResult = result;
    emitUpdate();
  };

  const { trackedScript, transformToOriginal } = injectLineTracking(scriptContent);

  // Build the wrapper as a plain string — no template literal interpolation.
  // This avoids breaking on backticks, ${}, or backslashes in user scripts.
  const wrapper =
    '(async function(delegate, delegateParallel, consoleLog, __trackLine, finish) {\n' +
    '  try {\n' +
    trackedScript +
    '\n  } catch(err) {\n' +
    '    throw err;\n' +
    '  }\n' +
    '})';

  // Generic line tracker — __trackLine receives the *original* line number
  // (the injector embeds the original line index in each call)
  const trackLine = (line: number) => {
    state.currentLine = line;
    emitUpdate();
  };

  try {
    const fn = new Function("delegate", "delegateParallel", "consoleLog", "__trackLine", "finish",
      'return (' + wrapper + ')(delegate, delegateParallel, consoleLog, __trackLine, finish);');
    const run = fn(delegate, delegateParallel, consoleLogFn, trackLine, finishFn);
    await run;
    state.status = "completed";
  } catch (err: any) {
    originalConsoleLog("[orchestrator] Script execution error:", err.message, err.stack);
    if (!state.errorMessage) {
      state.status = "error";
      state.errorMessage = err.message || String(err);
    }
  } finally {
    console.log = originalConsoleLog;
    state.consoleLogs = consoleLogBuffer;
  }

  emitUpdate();
  return state;
}

// ─── Extension ──────────────────────────────────────────────────────────────

const OrchestratorActionSchema = StringEnum(
  ["create", "view", "execute", "update", "abort", "restart"] as const,
  { description: "Action to perform", default: "view" },
);

const OrchestratorParams = Type.Object({
  action: Type.Optional(OrchestratorActionSchema),
  script: Type.Optional(Type.String({
    description: "TypeScript orchestration script content. " +
      "Used with action='create' (new script) or action='update' (replace current script). " +
      "The script uses delegate(session, agent, task, options?) and delegateParallel(tasks, options?) as globals.",
  })),
});

export default function (pi: ExtensionAPI) {
  let currentState: OrchestratorState | null = null;

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "orchestrator-state") {
        currentState = entry.data as OrchestratorState;
      }
    }
  });

  function persistState() {
    if (currentState) pi.appendEntry("orchestrator-state", currentState);
  }

  pi.registerTool({
    name: "orchestrator",
    label: "Orchestrator",
    description: [
      "Code-guided durable execution engine. Single tool for creating, viewing, and executing orchestration scripts.",
      "",
      "Actions:",
      "  create  — Create a new orchestration. Provide script (TypeScript content). Resets all state.",
      "  view    — View the current orchestration script and execution state. Default action.",
      "  execute — Execute the current script. Resumes from last completed delegate call if already running.",
      "  update  — Update the script in place. Resets execution state (pending all calls). Does not auto-execute.",
      "  abort   — Pause/abort current execution.",
      "  restart — Reset all delegate calls to pending and re-execute from scratch.",
      "",
      "The script is TypeScript with three injected globals:",
      "",
      "  delegate(session, agent, task)                    → run a subagent, returns text",
      "  delegateParallel(tasks, options?)                  → run independent subagents in parallel",
      "  consoleLog(...args)                                → log output visible in results (same as console.log)",
      "  finish(result)                                     → declare the final output of the orchestration",
      "                                                     (shown prominently in execute return value)",
      "",
      "delegate:",
      "  session  — string key. Same session → calls share history (previous outputs injected as context).",
      "  agent    — name of a configured subagent (e.g. 'scout', 'planner', 'worker').",
      "  task     — the task description for the subagent.",
      "  Returns the assistant's final text response from the last turn (a plain string).",
      "  If the agent uses tools (bash, read, etc.), only the final text message is returned —",
      "  tool call results are not included. Structure your task prompts so the agent summarizes",
      "  findings in its final text response.",
      "",
      "delegateParallel:",
      "  tasks    — [[session, agent, task], ...]. Every session must be unique.",
      "  options?.maxConcurrency — max concurrent subagent processes (default 4).",
      "  Returns [session, output][] — plain text strings (final assistant response per task).",
      "",
      "Script example:",
      "  const auth = await delegate('research', 'scout', 'Find all auth code');",
      "  const plan = await delegate('plan', 'planner', 'Plan OAuth integration based on: ' + auth);",
      "  finish('Authentication audit complete. Findings: ' + plan);",
      "",
      "finish(result):",
      "  Call finish() at the end of your script to declare the final output.",
      "  This is surfaced prominently in the execute return value.",
      "  Use it to summarize findings, list files changed, or provide actionable conclusions.",
      "  If finish() is not called, the return value will only show per-call previews (80 chars each).",
      "",
      "",
      "IMPORTANT — validate agents before committing to the plan:",
      "  Before creating the orchestration script, verify that each agent you plan to use exists",
      "  and has the right tools. Use 'subagent' with action 'list' to check available agents.",
      "  If an agent needs tools it doesn't have, create or update it first.",
      "  Do a quick dry-run test: call the agent directly with a short task to confirm it works",
      "  before embedding it in a multi-step orchestration. This catches failures (missing tools,",
      "  bad config) early instead of losing time executing a full plan that fails late.",
      "",
      "IMPORTANT — show the plan before executing:",
      "  After validating agents, create the orchestration script (action='create'), then use action='view'",
      "  to show the plan to the user for approval. Do NOT call action='execute' immediately.",
      "  Wait for the user to review the plan and explicitly approve it before executing.",
      "  If the plan needs changes, use action='update' and show the revised plan.",
      "",
      "Script rules:",
      "  - The script body is raw TypeScript — do NOT wrap it in a template literal or string.",
      "    Provide the code directly as the script parameter value.",
      "  - Only three globals are available: delegate, delegateParallel, consoleLog.",
      "    Pi tools (tavily_search, mcp, bash, read, etc.) are NOT available inside the script.",
      "  - The agent argument must be an agent name (e.g. 'scout', 'worker'), not a tool name.",
      "    Agents are defined in ~/.pi/agent/agents/*.md and must exist before delegating.",
      "  - Before using the orchestrator, ensure the agents you need are configured with the",
      "    right tools. Use the subagent tool to create or list agents, or write .md files in",
      "    ~/.pi/agent/agents/ with frontmatter: name, description, tools (comma-separated).",
      "    An agent's tool access is controlled by its 'tools' field — set it to include any",
      "    tools the agent needs (e.g. 'read,bash,tavily_search_tavily_search').",
      "  - Delegated agents run in their own isolated context with only their declared tools.",
      "    They do NOT inherit the parent orchestrator's tools or MCP servers.",
      "  - If you need an agent with tools that don't exist yet, create it first with the",
      "    subagent tool before referencing it in the orchestration script.",
      "  - Each delegate returns only the final assistant text. Structure task prompts so agents",
      "    summarize their findings — don't rely on tool call results being passed through."
    ].join(" "),
    promptSnippet: "Create, view, and execute code-guided orchestration scripts with durable delegate calls",
    promptGuidelines: [
      "Use orchestrator to coordinate multi-step workflows that require subagent delegation.",
      "Use action='create' with the script as an inline TypeScript string — no need to write files first.",
      "Use action='view' to inspect the current script and execution progress.",
      "Use action='execute' to run (or resume) the script.",
      "Use action='update' to modify the script mid-flight after seeing partial results.",
      "delegateParallel is for independent calls only — all sessions must be unique.",
      "Always show the plan to the user before executing: create the script, then view it for approval.",
      "Never call action='execute' on the same turn as action='create' — wait for user confirmation.",
      "Provide the script as raw TypeScript — never wrap it in a template literal or extra quotes.",
      "Use agent names (not tool names) in delegate() calls. Agents are defined in *.md files.",
      "Before orchestrating, verify agents exist with subagent action 'list'. Create missing agents first.",
      "Configure agent tools in their .md frontmatter to match what the delegated task requires.",
      "Before committing to a full orchestration plan, do a quick dry-run test of each agent with a short task.",
      "  This catches missing tools or bad config early, avoiding wasted time on late plan failures.",
      "Always call finish(result) at the end of the script to declare the final output.",
      "If the task needs web search or MCP tools, either give the agent those tools, or do those calls as the parent first.",
    ],
    parameters: OrchestratorParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action ?? "view";

      if (action === "view") {
        if (!currentState) {
          return { content: [{ type: "text", text: "No active orchestration. Use action='create' with a script to start one." }] };
        }
        return { content: [{ type: "text", text: formatView(currentState) }], details: currentState };
      }

      if (action === "create") {
        const script = params.script;
        if (!script || !script.trim()) {
          return { content: [{ type: "text", text: "Error: 'script' parameter required for action='create'. Provide the TypeScript orchestration script content." }] };
        }

        currentState = {
          script: script.trim(),
          delegateCalls: [],
          currentCall: 0,
          variables: {},
          sessionHistory: {},
          status: "draft",
          consoleLogs: [],
          scriptLines: script.trim().split('\n'),
        };
        persistState();

        return {
          content: [{ type: "text", text: `Orchestration created. Delegate calls tracked at runtime.\n\nUse action='execute' to run it.` }],
          details: currentState,
        };
      }

      if (action === "update") {
        if (!currentState) {
          return { content: [{ type: "text", text: "No active orchestration to update. Use action='create' first." }] };
        }
        const script = params.script;
        if (!script || !script.trim()) {
          return { content: [{ type: "text", text: "Error: 'script' parameter required for action='update'. Provide the new TypeScript orchestration script content." }] };
        }

        currentState.script = script.trim();
        currentState.delegateCalls = [];
        currentState.currentCall = 0;
        currentState.variables = {};
        currentState.sessionHistory = {};
        currentState.status = "draft";
        currentState.errorMessage = undefined;
        currentState.consoleLogs = [];
        currentState.scriptLines = script.trim().split('\n');
        persistState();

        return {
          content: [{ type: "text", text: `Orchestration updated. Delegate calls tracked at runtime.\n\nUse action='execute' to run it.` }],
          details: currentState,
        };
      }

      if (action === "execute") {
        if (!currentState) {
          return { content: [{ type: "text", text: "No active orchestration to execute. Use action='create' first." }] };
        }
        if (currentState.status === "completed") {
          return { content: [{ type: "text", text: "Orchestration already completed. Use action='restart' to rerun." }] };
        }

        currentState.status = "running";
        currentState.consoleLogs = [];
        persistState();

        // Show debug widget above the editor (no overlay — renders in normal flow)
        let widgetCleanup: (() => void) | null = null;
        try {
          widgetCleanup = setupOrchestratorWidget(ctx, currentState);
        } catch {}

        const finalState = await executeOrchestration(currentState, ctx, signal, onUpdate, () => {
          try { widgetCleanup?.(); widgetCleanup = setupOrchestratorWidget(ctx, currentState); } catch {}
        });
        persistState();

        try { widgetCleanup?.(); } catch {}

        return { content: [{ type: "text", text: formatExecuteSummary(finalState) }], details: finalState };
      }

      if (action === "abort") {
        if (!currentState) return { content: [{ type: "text", text: "No active orchestration." }] };
        currentState.status = "paused";
        persistState();
        return { content: [{ type: "text", text: "Orchestrator aborted." }] };
      }

      if (action === "restart") {
        if (!currentState) return { content: [{ type: "text", text: "No active orchestration to restart." }] };

        currentState.delegateCalls = [];
        currentState.currentCall = 0;
        currentState.status = "running";
        currentState.errorMessage = undefined;
        currentState.variables = {};
        currentState.sessionHistory = {};
        currentState.consoleLogs = [];
        currentState.startedAt = Date.now();
        persistState();

        let widgetCleanup: (() => void) | null = null;
        try {
          widgetCleanup = setupOrchestratorWidget(ctx, currentState);
        } catch {}

        const finalState = await executeOrchestration(currentState, ctx, signal, onUpdate, () => {
          try { widgetCleanup?.(); widgetCleanup = setupOrchestratorWidget(ctx, currentState); } catch {}
        });
        persistState();

        try { widgetCleanup?.(); } catch {}

        return { content: [{ type: "text", text: formatExecuteSummary(finalState) }], details: finalState };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
    },
  });

  pi.registerCommand("orchestrator", {
    description: "View orchestrator status",
    handler: async (_args, ctx) => {
      if (!currentState) { ctx.ui.notify("No active orchestration.", "info"); return; }
      ctx.ui.notify(formatExecuteSummary(currentState), "info");
    },
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "orchestrator" || !currentState) return;
    const completed = currentState.delegateCalls.filter((s) => s.status === "completed").length;
    const total = currentState.delegateCalls.length;
    if (total === 0 && currentState.status === "draft") {
      ctx.ui.setStatus("orchestrator", ctx.ui.theme.fg("muted", "draft"));
      return;
    }
    const icon = currentState.status === "completed" ? "✓" : currentState.status === "error" ? "✗" : currentState.status === "running" ? "⏳" : currentState.status === "draft" ? "✎" : "⏸";
    const color = currentState.status === "completed" ? "success" : currentState.status === "error" ? "error" : currentState.status === "running" ? "warning" : "muted";
    ctx.ui.setStatus("orchestrator", ctx.ui.theme.fg(color, `${icon} ${completed}/${total}`));
  });
}
