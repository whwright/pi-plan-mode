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
 *   --plan         — CLI flag to start in plan mode
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
import { extractTodoItems, isSafeCommand, markCompletedSteps } from "./utils/index.js";
import { applyModelForPhase, applyThinkingForPhase } from "./thinking.js";
import { showPlanSettings } from "./settings-ui.js";

/** Read-only tools available during the planning / exploration phase. */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

/** Full-access tools available during normal operation and execution phase. */
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

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

  // -----------------------------------------------------------------------
  // CLI flag
  // -----------------------------------------------------------------------
  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

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
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
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
      if (state.previousTools) {
        pi.setActiveTools(state.previousTools);
      } else {
        pi.setActiveTools(NORMAL_MODE_TOOLS);
      }
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
    description: "Configure plan mode (model, thinking effort)",
    handler: async (_args, ctx) => {
      const updated = await showPlanSettings(ctx, pi, config);

      // Apply changes to the live config
      config.planModel = updated.planModel;
      config.implModel = updated.implModel;
      config.planEffort = updated.planEffort;
      config.implEffort = updated.implEffort;

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

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step — what to change and why
2. Second step — what to change and why
...

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
    // Check if execution is complete
    if (state.phase === Phase.EXECUTING && state.todoItems.length > 0) {
      if (state.todoItems.every((t) => t.completed)) {
        const completedList = state.todoItems.map((t) => `~~${t.text}~~`).join("\n");
        displayWhenIdle(ctx, "plan-complete", `**Plan Complete!** ✓\n\n${completedList}`);
        state = transition(state, { type: "ALL_STEPS_DONE" });
        pi.setActiveTools(NORMAL_MODE_TOOLS);
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

    // Extract plan from last assistant message
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const items = extractTodoItems(getTextContent(lastAssistant));
      if (items.length > 0) {
        state = transition(state, { type: "PLAN_EXTRACTED", items });
      }
    }

    // Only prompt when a plan was actually extracted.
    // If the agent is still asking clarifying questions, let the user
    // respond naturally without the prompt blocking them.
    if (state.todoItems.length === 0) return;

    // Prevent duplicate prompts
    if (promptPending) return;
    promptPending = true;

    // Fire-and-forget: poll until idle, then show the prompt.
    // This lets agent_end return immediately so pi can finalize the run
    // and clear the spinner.
    void promptForNextAction(ctx);
  });

  // -----------------------------------------------------------------------
  // Show the post-plan prompt — runs AFTER the agent is fully idle.
  // This ensures triggering execution/refinement starts a clean new turn
  // instead of being spliced into the still-finalizing plan run.
  // -----------------------------------------------------------------------
  async function promptForNextAction(ctx: ExtensionContext): Promise<void> {
    try {
      const idle = await waitForIdle(ctx);

      // Show plan steps (only when truly idle to avoid steer continuation)
      if (idle && state.todoItems.length > 0) {
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
        state = transition(state, { type: "EXECUTE_CHOSEN" });

        await applyModelForPhase(pi, config, state.phase, ctx);
        applyThinkingForPhase(pi, config, state.phase);
        pi.setActiveTools(NORMAL_MODE_TOOLS);

        const firstStep = state.todoItems[0]?.text ?? "the plan";
        const execMessage =
          `Execute the entire plan autonomously, working through every step in order ` +
          `without waiting for another prompt. [DONE:n] tags (e.g. [DONE:1]) are ` +
          `progress milestones, not stopping points. Continue until all steps are complete. ` +
          `Start with step 1: ${firstStep}`;

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
      } else if (choice === "Refine the plan") {
        state = transition(state, { type: "REFINE_CHOSEN" });
        updateStatus(ctx);
        persistState();

        const refinement = await ctx.ui.editor("Refine the plan:", "");
        if (refinement?.trim()) {
          if (ctx.isIdle()) {
            pi.sendUserMessage(refinement.trim());
          } else {
            pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
          }
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
  // Event: restore state on session start / resume
  // -----------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    // Honor --plan flag
    if (pi.getFlag("plan") === true) {
      state = transition(state, { type: "TOGGLE" });
    }

    // Restore persisted config from file
    const entries = ctx.sessionManager.getEntries();
    await loadConfigFromFile(config);

    const planModeEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .pop() as { data?: PlanModeState & { todos?: PlanModeState["todoItems"] } } | undefined;

    const isResume = planModeEntry !== undefined;

    if (planModeEntry?.data) {
      state = {
        ...state,
        phase: planModeEntry.data.phase ?? state.phase,
        todoItems: planModeEntry.data.todos ?? state.todoItems,
        previousModel: planModeEntry.data.previousModel ?? state.previousModel,
        previousEffort: planModeEntry.data.previousEffort ?? state.previousEffort,
        previousTools: planModeEntry.data.previousTools ?? state.previousTools,
      };
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
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      applyThinkingForPhase(pi, config, state.phase);
    } else if (isPlanModeActive(state)) {
      pi.setActiveTools(resolvePlanModeTools(pi));
      applyThinkingForPhase(pi, config, state.phase);
    }

    updateStatus(ctx);
  });
}
