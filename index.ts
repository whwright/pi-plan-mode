/**
 * pi-plan-mode — Plan Mode Extension
 *
 * Adds a structured plan mode with two phases:
 *   1. Exploration (read-only, xhigh thinking) — agent explores and produces a plan.
 *   2. Execution (full tools, low thinking) — agent implements the plan step by step.
 *
 * Commands:
 *   /plan          — Toggle plan mode on/off
 *   Ctrl+Alt+P     — Toggle plan mode (shortcut)
 *
 * Drafted plans open in Plannotator's browser review when the
 * @plannotator/pi-extension is installed; otherwise a TUI prompt is shown.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";

import {
  createPlanModeConfig,
  loadConfigFromFile,
  saveConfigToFile,
} from "./config.js";
import {
  createInitialState,
  isPlanModeActive,
  isReadOnly,
  Phase,
  transition,
  type PlanModeState,
} from "./state.js";
import { extractPlanText, extractTodoItems, isSafeCommand, markCompletedSteps } from "./utils/index.js";
import { applyModelForPhase, applyThinkingForPhase } from "./thinking.js";
import { showPlanSettings } from "./settings-ui.js";
import {
  onPlanReviewResult,
  queryReviewStatus,
  requestPlanReview,
  type PlannotatorReviewResultEvent,
} from "./plannotator-client.js";

/** Read-only tools available during the planning / exploration phase. */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

/** Fallback tools for sessions that predate active-tool snapshots. */
const FALLBACK_NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Poll until the agent is idle so we can safely show a prompt. */
async function waitForIdle(ctx: ExtensionContext, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (!ctx.isIdle()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** Names of tools actually registered in this runtime. */
function availableToolNames(pi: ExtensionAPI): Set<string> {
  try {
    return new Set(pi.getAllTools().map((t) => t.name));
  } catch {
    return new Set();
  }
}

/** Filter PLAN_MODE_TOOLS to only tools actually registered. */
function resolvePlanModeTools(pi: ExtensionAPI): string[] {
  const available = availableToolNames(pi);
  return PLAN_MODE_TOOLS.filter((name) => available.has(name));
}

/** Restore the tools that were active before plan mode restricted them. */
function resolveNormalModeTools(pi: ExtensionAPI, previousTools?: string[]): string[] {
  const available = availableToolNames(pi);
  const tools = previousTools ?? FALLBACK_NORMAL_MODE_TOOLS;
  return tools.filter((name) => available.has(name));
}

function hasQuestionnaire(pi: ExtensionAPI): boolean {
  return availableToolNames(pi).has("questionnaire");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function planModeExtension(pi: ExtensionAPI): void {
  const config = createPlanModeConfig();
  let state: PlanModeState = createInitialState();
  let completedStepsInRun = 0;
  let executionContinuationPending = false;
  let promptPending = false;
  /** Latest context, for bus-event handlers that receive none. */
  let lastCtx: ExtensionContext | undefined;
  /** Raw markdown of the most recently extracted plan, for browser review. */
  let lastPlanText: string | null = null;
  /** Plan text last sent to Plannotator — used to detect superseded drafts. */
  let lastReviewedPlanText: string | null = null;
  /** A browser verdict waiting for a clean handoff to the agent. */
  let pendingReviewVerdict: { ctx: ExtensionContext; event: PlannotatorReviewResultEvent } | null = null;
  let reviewVerdictProcessing = false;
  let reviewVerdictRetryTimer: ReturnType<typeof setTimeout> | undefined;

  // -----------------------------------------------------------------------
  // Footer status & progress widget
  // -----------------------------------------------------------------------
  function updateStatus(ctx: ExtensionContext): void {
    if (state.phase === Phase.EXECUTING && state.todoItems.length > 0) {
      const completed = state.todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${state.todoItems.length}`));

      const lines = state.todoItems.map((item) => {
        if (item.completed) {
          return (
            ctx.ui.theme.fg("success", "☑ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          );
        }
        return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
      });
      ctx.ui.setWidget("plan-todos", lines);
    } else if (isPlanModeActive(state)) {
      const label = state.phase === Phase.PLAN_READY && state.pendingReviewId
        ? "⏸ plan · reviewing"
        : "⏸ plan";
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", label));
      ctx.ui.setWidget("plan-todos", undefined);
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
      ctx.ui.setWidget("plan-todos", undefined);
    }
  }

  // -----------------------------------------------------------------------
  // Persist state to session so it survives restarts
  // -----------------------------------------------------------------------
  function persistState(): void {
    pi.appendEntry("plan-mode", {
      phase: state.phase,
      todos: state.todoItems,
      previousModel: state.previousModel,
      previousEffort: state.previousEffort,
      previousTools: state.previousTools,
      pendingReviewId: state.pendingReviewId,
      planText: lastPlanText ?? undefined,
    });
  }

  // -----------------------------------------------------------------------
  // Deferred display — wait until the agent is idle so the message doesn't
  // enqueue a steer continuation and re-trigger the agent.
  // -----------------------------------------------------------------------
  function displayWhenIdle(ctx: ExtensionContext, customType: string, content: string): void {
    void (async () => {
      try {
        if (await waitForIdle(ctx)) {
          pi.sendMessage({ customType, content, display: true }, { triggerTurn: false });
        }
      } catch {
        // ctx may be stale after a session switch/reload; ignore.
      }
    })();
  }

  // -----------------------------------------------------------------------
  // Toggle plan mode
  // -----------------------------------------------------------------------
  async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
    const prev = state;
    state = transition(state, { type: "TOGGLE" });

    if (isPlanModeActive(state)) {
      // Entering plan mode: snapshot current settings, apply planning config
      state = {
        ...state,
        previousModel: ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : prev.previousModel,
        previousEffort: pi.getThinkingLevel(),
        previousTools: pi.getActiveTools(),
      };

      await applyModelForPhase(pi, config, state.phase, ctx);
      applyThinkingForPhase(pi, config, state.phase);

      const planTools = resolvePlanModeTools(pi);
      pi.setActiveTools(planTools);

      ctx.ui.notify(
        `Plan mode enabled (${config.planEffort} thinking). ` +
          `Read-only tools: ${planTools.join(", ")}`,
      );
    } else {
      // Exiting plan mode: restore previous model, effort, and tools
      if (state.previousModel) {
        const prevModel = ctx.modelRegistry.find(
          state.previousModel.provider,
          state.previousModel.id,
        );
        if (prevModel) await pi.setModel(prevModel);
      }
      if (state.previousEffort) {
        pi.setThinkingLevel(state.previousEffort);
      }
      pi.setActiveTools(resolveNormalModeTools(pi, state.previousTools));
      state = { ...state, todoItems: [] };
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }

    updateStatus(ctx);
    persistState();
  }

  // -----------------------------------------------------------------------
  // Commands & shortcuts
  // -----------------------------------------------------------------------
  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args, ctx) => {
      await togglePlanMode(ctx);
    },
  });

  pi.registerCommand("plan-settings", {
    description: "Configure plan mode (models, thinking, and presets)",
    handler: async (_args, ctx) => {
      const updated = await showPlanSettings(ctx, pi, config);

      // Apply changes to the live config
      config.planModel = updated.planModel;
      config.implModel = updated.implModel;
      config.planEffort = updated.planEffort;
      config.implEffort = updated.implEffort;
      config.presets = Object.fromEntries(
        Object.entries(updated.presets).map(([name, preset]) => [name, {
          ...preset,
          planModel: preset.planModel ? { ...preset.planModel } : undefined,
          implModel: preset.implModel ? { ...preset.implModel } : undefined,
        }]),
      );
      config.plannotatorReview = updated.plannotatorReview;

      // Persist to file so settings survive all sessions
      await saveConfigToFile(config);

      // If currently in an active plan mode phase, re-apply thinking effort
      if (isPlanModeActive(state)) {
        applyThinkingForPhase(pi, config, state.phase);
      }

      ctx.ui.notify(
        `Plan settings: plan=${config.planEffort} / impl=${config.implEffort}` +
          (config.planModel ? ` / model=${config.planModel.provider}/${config.planModel.modelId}` : ""),
        "info",
      );
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => {
      await togglePlanMode(ctx);
    },
  });

  // -----------------------------------------------------------------------
  // Event: block destructive bash commands in plan mode
  // -----------------------------------------------------------------------
  pi.on("tool_call", async (event) => {
    if (!isPlanModeActive(state) || event.toolName !== "bash") return;
    if (!isReadOnly(state)) return; // execution phase has full access

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason:
          `Plan mode: command blocked (not allowlisted). ` +
          `Use /plan to disable plan mode first.\nCommand: ${command}`,
      };
    }
  });

  // -----------------------------------------------------------------------
  // Event: filter stale plan-mode context when not in plan mode
  // -----------------------------------------------------------------------
  pi.on("context", async (event) => {
    if (isPlanModeActive(state)) return;

    return {
      messages: event.messages.filter((m) => {
        const entry = m as { customType?: string; role?: string };
        if (entry.customType === "plan-mode-context") return false;
        if (entry.customType === "plan-execution-context") return false;
        if (entry.customType === "plan-todo-list") return false;
        if (entry.customType === "plan-mode-execute") return false;
        return true;
      }),
    };
  });

  // -----------------------------------------------------------------------
  // Event: inject planning / execution context before each turn
  // -----------------------------------------------------------------------
  pi.on("before_agent_start", async () => {
    // Execution phase: inject remaining steps
    if (state.phase === Phase.EXECUTING && state.todoItems.length > 0) {
      const remaining = state.todoItems.filter((t) => !t.completed);
      const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN — Full tool access enabled]

Remaining steps:
${todoList}

Execute the entire remaining plan autonomously and in order. [DONE:n] markers are
progress milestones only; they are not handoff points and never require a user
prompt. Do not stop after an item or ask the user to continue. Continue working
until every remaining step is complete. Pause only when genuinely blocked by
missing information or an irreversible decision that requires the user's input.
After completing each step, include a [DONE:n] tag in your response (e.g. [DONE:1]).`,
          display: false,
        },
      };
    }

    // Planning phases: inject exploration context
    if (state.phase !== Phase.PLANNING && state.phase !== Phase.PLAN_READY) return;

    const planTools = resolvePlanModeTools(pi);
    const clarifyLine = hasQuestionnaire(pi)
      ? "Ask clarifying questions using the questionnaire tool."
      : "Ask clarifying questions in plain text and wait for the user's reply before planning.";

    return {
      message: {
        customType: "plan-mode-context",
        content: `[PLAN MODE — EXPLORATION]
You are in exploration mode (read-only).

Restrictions:
- You can only use: ${planTools.join(", ")}
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

This is a two-effort workflow: you plan on ${config.planEffort} effort, and the plan is then executed on ${config.implEffort} effort. Produce a plan precise enough that the lower-effort execution pass can implement it without re-deriving your reasoning.

${clarifyLine}

Create a detailed numbered plan under a "Plan:" header. Use EXACTLY the format
shown below — plain numbered list items, no markdown headings, no bold, no
"###" prefixes:

Plan:
1. First step — what to change and why
2. Second step — what to change and why

Do NOT attempt to make changes — just describe what you would do.`,
        display: false,
      },
    };
  });

  // -----------------------------------------------------------------------
  // Event: track [DONE:n] markers after each turn
  // -----------------------------------------------------------------------
  pi.on("agent_start", async () => {
    if (state.phase === Phase.EXECUTING) completedStepsInRun = 0;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (state.phase !== Phase.EXECUTING || state.todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    const completed = markCompletedSteps(text, state.todoItems);
    completedStepsInRun += completed;
    if (completed > 0) {
      updateStatus(ctx);
      persistState();
    }
  });

  function continueExecutionWhenIdle(ctx: ExtensionContext): void {
    if (executionContinuationPending) return;
    executionContinuationPending = true;

    void (async () => {
      try {
        if (
          await waitForIdle(ctx) &&
          state.phase === Phase.EXECUTING &&
          state.todoItems.some((item) => !item.completed)
        ) {
          pi.sendUserMessage(
            "Continue executing the remaining plan now. Do not stop at [DONE] markers; complete every remaining step before responding.",
          );
        }
      } catch {
        // The session may have changed while the prior run was finalizing.
      } finally {
        executionContinuationPending = false;
      }
    })();
  }

  // -----------------------------------------------------------------------
  // Event: extract plan, check execution completion
  //
  // CRITICAL: agent_end must NOT await the post-plan prompt. agent_end runs
  // while the agent may still be finalizing, so any pi.sendMessage or
  // sendUserMessage can enqueue a steer continuation that re-triggers the
  // agent (infinite re-plan loop). We extract the plan, check completion,
  // and fire-and-forget the prompt via poll-then-show.
  // -----------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;

    // Check if execution is complete
    if (state.phase === Phase.EXECUTING && state.todoItems.length > 0) {
      if (state.todoItems.every((t) => t.completed)) {
        const completedList = state.todoItems.map((t) => `~~${t.text}~~`).join("\n");
        displayWhenIdle(ctx, "plan-complete", `**Plan Complete!** ✓\n\n${completedList}`);
        state = transition(state, { type: "ALL_STEPS_DONE" });
        pi.setActiveTools(resolveNormalModeTools(pi, state.previousTools));
        updateStatus(ctx);
        persistState();
      } else if (completedStepsInRun > 0) {
        // A progress marker must never make the user restart execution.
        continueExecutionWhenIdle(ctx);
      }
      return;
    }

    if (!isPlanModeActive(state) || !ctx.hasUI) return;
    if (state.phase !== Phase.PLANNING && state.phase !== Phase.PLAN_READY) return;

    // A browser verdict is already associated with this plan. Do not open a
    // second review while its execution/refinement handoff is waiting for the
    // agent to become idle.
    if (pendingReviewVerdict) {
      processPendingReviewVerdict();
      return;
    }

    // Extract plan from last assistant message
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const text = getTextContent(lastAssistant);
      const items = extractTodoItems(text);
      if (items.length > 0) {
        const planText = extractPlanText(text) ?? text;
        const planChanged = lastPlanText !== null && planText !== lastPlanText;
        state = transition(state, { type: "PLAN_EXTRACTED", items });
        lastPlanText = planText;
        // A new draft supersedes the old browser review. Its verdict must not
        // be applied to the newly extracted plan if the user later decides it.
        if (planChanged && state.pendingReviewId) {
          state = { ...state, pendingReviewId: undefined };
          persistState();
        }
      }
    }

    // Only prompt when a plan was actually extracted.
    // If the agent is still asking clarifying questions, let the user
    // respond naturally without the prompt blocking them.
    if (state.todoItems.length === 0) return;

    // A browser review for this exact draft is already awaiting a verdict.
    // If the plan changed since, fall through and open a fresh review — an
    // abandoned or superseded review must never deadlock the session.
    if (
      state.pendingReviewId &&
      lastPlanText !== null &&
      lastPlanText === lastReviewedPlanText
    ) {
      ctx.ui.notify("Plan review is open in your browser — awaiting your decision.", "info");
      return;
    }

    // Prevent duplicate prompts
    if (promptPending) return;
    promptPending = true;

    // Fire-and-forget: poll until idle, then open the Plannotator browser
    // review (falling back to the TUI prompt when Plannotator is absent).
    // This lets agent_end return immediately so pi can finalize the run
    // and clear the spinner.
    attemptBrowserReview(ctx);
  });

  // -----------------------------------------------------------------------
  // Execution / refinement helpers — shared by the TUI prompt fallback and
  // the Plannotator browser verdicts.
  // -----------------------------------------------------------------------
  async function startExecution(ctx: ExtensionContext, reviewerNotes?: string): Promise<void> {
    state = transition(state, { type: "EXECUTE_CHOSEN" });

    await applyModelForPhase(pi, config, state.phase, ctx);
    applyThinkingForPhase(pi, config, state.phase);
    pi.setActiveTools(resolveNormalModeTools(pi, state.previousTools));

    const firstStep = state.todoItems[0]?.text ?? "the plan";
    let execMessage =
      `Execute the entire plan autonomously, working through every step in order ` +
      `without waiting for another prompt. [DONE:n] tags (e.g. [DONE:1]) are ` +
      `progress milestones, not stopping points. Continue until all steps are complete. ` +
      `Start with step 1: ${firstStep}`;
    if (reviewerNotes?.trim()) {
      execMessage += `\n\nImplementation notes from the plan reviewer:\n${reviewerNotes.trim()}`;
    }

    // Persist a marker so /resume can re-scan [DONE:n] from this point
    pi.appendEntry("plan-mode-execute", { execMessage });

    // Use sendUserMessage (not sendMessage+triggerTurn) so before_agent_start
    // fires and injects the execution context with [DONE:n] instructions.
    if (ctx.isIdle()) {
      pi.sendUserMessage(execMessage);
    } else {
      pi.sendUserMessage(execMessage, { deliverAs: "followUp" });
    }

    updateStatus(ctx);
    persistState();
  }

  function sendRefinement(ctx: ExtensionContext, feedback: string): void {
    state = transition(state, { type: "REFINE_CHOSEN" });
    updateStatus(ctx);
    persistState();

    if (ctx.isIdle()) {
      pi.sendUserMessage(feedback);
    } else {
      pi.sendUserMessage(feedback, { deliverAs: "followUp" });
    }
  }

  // -----------------------------------------------------------------------
  // Plannotator browser review
  // -----------------------------------------------------------------------

  /** Retry a verdict handoff until the agent is idle. */
  function processPendingReviewVerdict(): void {
    if (!pendingReviewVerdict || reviewVerdictProcessing) return;

    const pending = pendingReviewVerdict;
    reviewVerdictProcessing = true;
    void (async () => {
      try {
        if (!(await waitForIdle(pending.ctx))) {
          pending.ctx.ui.notify(
            "Plan review decision received; waiting for the current turn to finish before continuing.",
            "info",
          );
          reviewVerdictRetryTimer = setTimeout(() => {
            reviewVerdictRetryTimer = undefined;
            reviewVerdictProcessing = false;
            processPendingReviewVerdict();
          }, 1000);
          return;
        }

        // A session switch, mode toggle, or newer verdict may have superseded this one.
        if (pendingReviewVerdict !== pending) return;
        if (state.phase !== Phase.PLAN_READY) {
          pendingReviewVerdict = null;
          return;
        }
        pendingReviewVerdict = null;

        if (pending.event.approved) {
          await startExecution(pending.ctx, pending.event.feedback);
        } else {
          const feedback = pending.event.feedback?.trim() ||
            "The reviewer rejected the plan without comments. Please revise it.";
          sendRefinement(
            pending.ctx,
            `Plan review feedback (annotations from the reviewer):\n\n${feedback}\n\n` +
              `Revise the plan accordingly and output the updated numbered plan under a "Plan:" header.`,
          );
        }
      } catch {
        // ctx may be stale after a session switch/reload; ignore.
        pendingReviewVerdict = null;
      } finally {
        reviewVerdictProcessing = false;
      }
    })();
  }

  /** Execute or refine according to an accepted browser verdict. */
  function applyVerdict(ctx: ExtensionContext, event: PlannotatorReviewResultEvent): void {
    if (pendingReviewVerdict) return;

    pendingReviewVerdict = { ctx, event };
    state = { ...state, pendingReviewId: undefined };
    persistState();
    updateStatus(ctx);
    processPendingReviewVerdict();
  }

  /** Route a browser verdict into execution or refinement. */
  function handleReviewResult(ctx: ExtensionContext, event: PlannotatorReviewResultEvent): void {
    if (state.phase !== Phase.PLAN_READY) return;

    // The shared bus carries results for every Plannotator session. Only the
    // review explicitly persisted for this plan may control this extension.
    if (!state.pendingReviewId || event.reviewId !== state.pendingReviewId) return;

    applyVerdict(ctx, event);
  }

  /**
   * Try to open the drafted plan in Plannotator's browser review.
   * Falls back to the TUI prompt when Plannotator is absent or fails.
   */
  function attemptBrowserReview(ctx: ExtensionContext): void {
    void (async () => {
      try {
        const idle = await waitForIdle(ctx);
        if (!idle || state.phase !== Phase.PLAN_READY) {
          if (!idle) {
            ctx.ui.notify("Plan review could not be opened while the agent was busy.", "warning");
            reviewVerdictRetryTimer = setTimeout(() => {
              reviewVerdictRetryTimer = undefined;
              if (state.phase === Phase.PLAN_READY && !promptPending) {
                promptPending = true;
                attemptBrowserReview(ctx);
              }
            }, 1000);
          }
          return;
        }
        if (!config.plannotatorReview || !lastPlanText) {
          await promptForNextAction(ctx);
          return;
        }

        const review = await requestPlanReview(pi, lastPlanText);
        if (!review) {
          // Plannotator not installed / unavailable — TUI fallback.
          await promptForNextAction(ctx);
          return;
        }

        lastReviewedPlanText = lastPlanText;
        state = { ...state, pendingReviewId: review.reviewId };
        persistState();
        updateStatus(ctx);
        ctx.ui.notify(
          "Plan opened in Plannotator — approve or annotate in your browser.",
          "info",
        );
      } catch {
        // Fall back to the TUI prompt on any unexpected failure.
        try {
          await promptForNextAction(ctx);
        } catch {
          // ctx may be stale after a session switch/reload; ignore.
        }
      } finally {
        promptPending = false;
      }
    })();
  }

  // -----------------------------------------------------------------------
  // Show the post-plan prompt — runs AFTER the agent is fully idle.
  // This ensures triggering execution/refinement starts a clean new turn
  // instead of being spliced into the still-finalizing plan run.
  // -----------------------------------------------------------------------
  async function promptForNextAction(ctx: ExtensionContext): Promise<void> {
    try {
      const idle = await waitForIdle(ctx);
      if (!idle) {
        ctx.ui.notify("Plan mode is still waiting for the agent to become idle.", "warning");
        return;
      }

      // Show plan steps only when truly idle to avoid a steer continuation.
      if (state.todoItems.length > 0) {
        const todoListText = state.todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
        pi.sendMessage(
          { customType: "plan-todo-list", content: `**Plan Steps (${state.todoItems.length}):**\n\n${todoListText}`, display: true },
          { triggerTurn: false },
        );
      }

      const choice = await ctx.ui.select("Plan mode — what next?", [
        "Execute the plan (track progress)",
        "Stay in plan mode",
        "Refine the plan",
      ]);

      if (choice?.startsWith("Execute")) {
        await startExecution(ctx);
      } else if (choice === "Refine the plan") {
        const refinement = await ctx.ui.editor("Refine the plan:", "");
        if (refinement?.trim()) {
          sendRefinement(ctx, refinement.trim());
        }
      }
      // "Stay in plan mode" — do nothing, user can keep exploring
    } catch (err) {
      try {
        ctx.ui.notify(
          `Plan mode: prompt failed (${err instanceof Error ? err.message : String(err)})`,
          "warning",
        );
      } catch {
        // ctx may be stale after a session switch/reload; ignore.
      }
    } finally {
      promptPending = false;
    }
  }

  // -----------------------------------------------------------------------
  // Plannotator browser verdicts arrive on the shared event bus (no ctx).
  // -----------------------------------------------------------------------
  onPlanReviewResult(pi, (event) => {
    if (!lastCtx) return;
    handleReviewResult(lastCtx, event);
  });

  // -----------------------------------------------------------------------
  // Event: restore state on session start / resume
  // -----------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;

    // Restore persisted config from file
    const entries = ctx.sessionManager.getEntries();
    await loadConfigFromFile(config);

    const planModeEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .pop() as { data?: PlanModeState & { todos?: PlanModeState["todoItems"]; planText?: string } } | undefined;

    const isResume = planModeEntry !== undefined;

    if (planModeEntry?.data) {
      state = {
        ...state,
        phase: planModeEntry.data.phase ?? state.phase,
        todoItems: planModeEntry.data.todos ?? state.todoItems,
        previousModel: planModeEntry.data.previousModel ?? state.previousModel,
        previousEffort: planModeEntry.data.previousEffort ?? state.previousEffort,
        previousTools: planModeEntry.data.previousTools ?? state.previousTools,
        pendingReviewId: planModeEntry.data.pendingReviewId ?? state.pendingReviewId,
      };
      if (planModeEntry.data.planText) {
        lastPlanText = planModeEntry.data.planText;
      }
    }

    // Recover a Plannotator review that was pending when the session ended.
    if (state.phase === Phase.PLAN_READY && state.pendingReviewId) {
      // The persisted plan is the review currently open in the browser. Keep
      // the duplicate-draft guard warm across a session reload as well.
      if (lastPlanText) lastReviewedPlanText = lastPlanText;
      const reviewId = state.pendingReviewId;
      void (async () => {
        try {
          const status = await queryReviewStatus(pi, reviewId);
          if (status?.status === "completed") {
            // The verdict arrived while we were away — act on it.
            handleReviewResult(ctx, status);
            return;
          }
          if (status?.status === "pending") {
            ctx.ui.notify(
              "Plan review is still open in your browser — awaiting your decision.",
              "info",
            );
            return;
          }
          if (status?.status === "missing") {
            state = { ...state, pendingReviewId: undefined };
            persistState();
            updateStatus(ctx);
            if (state.todoItems.length > 0 && !promptPending) {
              promptPending = true;
              attemptBrowserReview(ctx);
            }
            return;
          }
          // Plannotator is unavailable. Discard this browser handoff and use
          // the terminal prompt; any late result for the old ID is ignored.
          state = { ...state, pendingReviewId: undefined };
          persistState();
          updateStatus(ctx);
          if (state.todoItems.length > 0 && !promptPending) {
            promptPending = true;
            await promptForNextAction(ctx);
          }
        } catch {
          // ctx may be stale after a session switch/reload; ignore.
        }
      })();
    }

    // On resume mid-execution: re-scan messages after the execution start
    // marker to rebuild [DONE:n] completion state.
    if (isResume && state.phase === Phase.EXECUTING && state.todoItems.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i] as { type: string; message?: AgentMessage };
        if (entry.type === "message" && entry.message && isAssistantMessage(entry.message)) {
          messages.push(entry.message);
        }
      }

      const allText = messages.map(getTextContent).join("\n");
      markCompletedSteps(allText, state.todoItems);
    }

    // Apply the right tool set and thinking for the restored phase
    if (state.phase === Phase.EXECUTING) {
      pi.setActiveTools(resolveNormalModeTools(pi, state.previousTools));
      applyThinkingForPhase(pi, config, state.phase);
    } else if (isPlanModeActive(state)) {
      pi.setActiveTools(resolvePlanModeTools(pi));
      applyThinkingForPhase(pi, config, state.phase);
    }

    updateStatus(ctx);
  });
}
