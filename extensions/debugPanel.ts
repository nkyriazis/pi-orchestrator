import { Container, matchesKey, Key, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { highlightCode } from "@earendil-works/pi-coding-agent";

/** Pad a styled string to a target visible width (space-filled). */
function padTo(str: string, target: number): string {
  const w = visibleWidth(str);
  if (w >= target) return str;
  return str + ' '.repeat(target - w);
}

/** Truncate a styled string to max visible width. */
function sliceTo(str: string, maxVisible: number): string {
  return truncateToWidth(str, maxVisible, '');
}

import type { Tui, Theme } from "@earendil-works/pi-tui";

export interface DebugPanelState {
  script: string;
  delegateCalls: Array<{
    index: number;
    agent: string;
    session: string;
    task: string;
    status: "pending" | "running" | "completed" | "error";
    error?: string;
    outputPreview?: string;
    durationMs?: number;
    label?: string;
    currentStep?: string;
  }>;
  status: string;
  currentLine?: number;
  consoleLogs?: string[];
}

export class OrchestratorDebugPanel extends Container {
  private theme: Theme;
  private tui: Tui;
  private stateRef: () => DebugPanelState;
  private done: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(tui: Tui, theme: Theme, stateRef: () => DebugPanelState, done: () => void) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.stateRef = stateRef;
    this.done = done;

    // Animate spinner for running steps
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerFrames.length;
      this.invalidate();
      tui.requestRender();
    }, 120);
  }

  destroy(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;

    const state = this.stateRef();
    const scriptLines = state.script.split('\n');
    const divider = this.theme.fg("border", "│");
    // Two equal panes separated by 1-char divider
    const paneWidth = Math.floor((width - 1) / 2);

    // Fixed body height to prevent trails from shrinking/growing frames
    const fixedBodyHeight = Math.max(16, Math.min(24, (process.stdout.rows || 30) - 6));

    const leftLines = this.renderScriptPane(scriptLines, state.currentLine ?? 0, paneWidth, fixedBodyHeight);
    const rightLines = this.renderDetailPane(state, paneWidth, fixedBodyHeight);

    const lines: string[] = [];

    // Title bar
    const titleFill = Math.max(0, width - 18);
    lines.push(this.theme.fg("borderAccent", "┌─ ORCHESTRATOR DEBUG " + "─".repeat(titleFill) + "┐"));

    for (let i = 0; i < fixedBodyHeight; i++) {
      const left = sliceTo(padTo(leftLines[i] || "", paneWidth), paneWidth);
      const right = sliceTo(padTo(rightLines[i] || "", paneWidth), paneWidth);
      lines.push(left + divider + right);
    }

    // Status bar
    const statusColor = state.status === "completed" ? "success" : state.status === "error" ? "error" : "warning";
    const completed = state.delegateCalls.filter((c) => c.status === "completed").length;
    const running = state.delegateCalls.filter((c) => c.status === "running").length;
    const statusBar = ` ${state.status} | ${completed} done | ${running} running | ${state.delegateCalls.length} total | esc: close`;
    const statusFill = Math.max(0, width - visibleWidth(statusBar) - 4);
    lines.push(this.theme.fg(statusColor, "└─ " + statusBar + "─".repeat(statusFill) + "┘"));

    this.cachedLines = lines;
    return lines;
  }

  private renderScriptPane(scriptLines: string[], currentLine: number, width: number, fixedHeight: number): string[] {
    const lines: string[] = [];
    const numWidth = String(scriptLines.length).length + 1;

    // Title
    lines.push(this.theme.fg("borderMuted", sliceTo(" SCRIPT ──" + "─".repeat(Math.max(0, width - 10)), width)));

    // Highlight each line individually to preserve 1:1 line mapping
    // (highlightCode on the full script can wrap long lines, breaking alignment)
    const highlighted: string[] = [];
    for (const line of scriptLines) {
      const result = highlightCode(line, 'typescript');
      // highlightCode returns an array; take first line (single input line)
      highlighted.push(result[0] ?? line);
    }

    // Fixed view window around current line
    const viewHeight = fixedHeight - 2; // title + "more lines" indicator
    const halfView = Math.floor(viewHeight / 2);
    const startLine = Math.max(0, currentLine - halfView);
    const endLine = Math.min(highlighted.length, startLine + viewHeight);

    for (let i = startLine; i < endLine; i++) {
      const actualLine = i;
      const lineNum = String(actualLine + 1).padStart(numWidth);
      const code = highlighted[i] || scriptLines[i] || "";
      const codeBudget = width - numWidth - 4;
      const codeSlice = sliceTo(code, codeBudget);

      if (actualLine === currentLine) {
        const raw = `▸ ${lineNum} │ ${codeSlice}`;
        lines.push(this.theme.fg("accent", padTo(raw, width)));
      } else {
        const prefix = this.theme.fg("muted", `  ${lineNum} │ `);
        lines.push(padTo(prefix + codeSlice, width));
      }
    }

    // Remaining lines indicator
    if (endLine < highlighted.length) {
      lines.push(this.theme.fg("dim", ` ... ${highlighted.length - endLine} more lines`));
    }

    return lines;
  }

  private renderDetailPane(state: DebugPanelState, width: number, fixedHeight: number): string[] {
    const lines: string[] = [];

    // Title
    lines.push(this.theme.fg("borderMuted", sliceTo(" DETAILS ──" + "─".repeat(Math.max(0, width - 11)), width)));
    lines.push("");

    // Call list
    const calls = state.delegateCalls;
    for (const call of calls) {
      const icon =
        call.status === "completed" ? "✓" :
        call.status === "error" ? "✗" :
        call.status === "running" ? this.spinnerFrames[this.spinnerFrame] : "○";

      const color =
        call.status === "completed" ? "success" :
        call.status === "error" ? "error" :
        call.status === "running" ? "warning" : "muted";

      const timing = call.durationMs != null ? ` ${call.durationMs}ms` : "";
      const label = call.label ? ` (${call.label})` : "";
      const sessionInfo = call.session !== "?" ? `[${call.session}]` : "";
      const stepInfo = call.currentStep ? ` → ${call.currentStep}` : "";

      const line = `  ${icon} Call ${call.index + 1}${label}: ${call.agent}${sessionInfo}${timing}`;
      lines.push(sliceTo(this.theme.fg(color, line), width));
      if (call.currentStep && call.status === "running") {
        lines.push(sliceTo(this.theme.fg("muted", `     └─ ${call.currentStep}`), width));
      }

      if (call.error) {
        lines.push(sliceTo(this.theme.fg("error", `     └─ ${call.error}`), width));
      }
      if (call.outputPreview && call.status === "completed" && !call.error) {
        const preview = call.outputPreview.length > 60
          ? call.outputPreview.slice(0, 60) + "…"
          : call.outputPreview;
        lines.push(sliceTo(this.theme.fg("dim", `     └─ ${preview}`), width));
      }
    }

    if (calls.length === 0) {
      lines.push(this.theme.fg("dim", "  (no calls yet)"));
    }

    lines.push("");

    // Console log tail
    if (state.consoleLogs && state.consoleLogs.length > 0) {
      lines.push(this.theme.fg("borderMuted", sliceTo(" CONSOLE ──" + "─".repeat(Math.max(0, width - 11)), width)));
      for (const log of state.consoleLogs.slice(-5)) {
        lines.push(sliceTo(this.theme.fg("dim", `  > ${log}`), width));
      }
    }

    return lines;
  }

  invalidate(): void {
    super.invalidate();
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
