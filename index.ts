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

import { loadConfig } from "./config.js";
import {
  createInitialState,
  isPlanModeActive,
  Phase,
  transition,
  type PlanModeState,
} from "./state.js";
import { extractTodoItems, isSafeCommand, markCompletedSteps } from "./utils/index.js";
import { applyModelForPhase, applyThinkingForPhase } from "./thinking.js";

/** Read-only tools available during the planning / exploration phase. */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

/** Full-access tools available during normal operation and execution phase. */
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

export default function planModeExtension(pi: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // Module-level state (singleton per session)
  // -----------------------------------------------------------------------
  const config = loadConfig();
  let state: PlanModeState = createInitialState();

  // -----------------------------------------------------------------------
  // CLI flag
  // -----------------------------------------------------------------------
  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  // -----------------------------------------------------------------------
  // Footer status
  // -----------------------------------------------------------------------
  function updateStatus(ctx: ExtensionContext): void {
    if (state.phase === Phase.EXECUTING && state.todoItems.length > 0) {
      // Show progress counter in footer
      const completed = state.todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `📋 ${completed}/${state.todoItems.length}`),
      );

      // Show progress widget above editor
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
    } else if (state.phase === Phase.PLANNING || state.phase === Phase.PLAN_READY) {
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
      pi.setActiveTools(PLAN_MODE_TOOLS);

      ctx.ui.notify(
        `Plan mode enabled (${config.planEffort} thinking). ` +
          `Read-only tools: ${PLAN_MODE_TOOLS.join(", ")}`,
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
  // Event: inject planning context when plan mode is active
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

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response (e.g. "[DONE:1] done").`,
          display: false,
        },
      };
    }

    // Planning phases: inject exploration context
    if (state.phase !== Phase.PLANNING && state.phase !== Phase.PLAN_READY) return;

    return {
      message: {
        customType: "plan-mode-context",
        content: `[PLAN MODE — EXPLORATION]
You are in exploration mode (read-only). Available tools:
  read, bash, grep, find, ls, questionnaire

You CANNOT edit or write files. Bash is restricted to read-only commands.
Use the questionnaire tool if you need to ask clarifying questions.

Goal: Understand the problem deeply, then produce a detailed numbered plan.

When ready, output your plan under a "Plan:" header:

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
  // Message helpers: narrow agent messages to assistant text
  // -----------------------------------------------------------------------
  function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
    return m.role === "assistant" && Array.isArray(m.content);
  }

  function getTextContent(message: AssistantMessage): string {
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  // -----------------------------------------------------------------------
  // Event: track [DONE:n] markers after each turn
  // -----------------------------------------------------------------------
  pi.on("turn_end", async (event, ctx) => {
    if (state.phase !== Phase.EXECUTING || state.todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, state.todoItems) > 0) {
      updateStatus(ctx);
      persistState();
    }
  });

  // -----------------------------------------------------------------------
  // Event: extract plan and prompt user for next action
  // -----------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    // Handle execution completion: check if all steps are done
    if (state.phase === Phase.EXECUTING && state.todoItems.length > 0) {
      if (state.todoItems.every((t) => t.completed)) {
        const completedList = state.todoItems
          .map((t) => `~~${t.text}~~`)
          .join("\n");
        pi.sendMessage(
          {
            customType: "plan-complete",
            content: `**Plan Complete!** ✓\n\n${completedList}`,
            display: true,
          },
          { triggerTurn: false },
        );
        state = transition(state, { type: "ALL_STEPS_DONE" });
        pi.setActiveTools(NORMAL_MODE_TOOLS);
        updateStatus(ctx);
        persistState();
      }
      return;
    }
    // Only act in planning phases, and only when the UI is available
    if (state.phase !== Phase.PLANNING && state.phase !== Phase.PLAN_READY) return;
    if (!ctx.hasUI) return;

    // Find the last assistant message and try to extract a plan
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const items = extractTodoItems(getTextContent(lastAssistant));
      if (items.length > 0) {
        state = transition(state, { type: "PLAN_EXTRACTED", items });
      }
    }

    // Only prompt if we have plan items
    if (state.todoItems.length === 0) return;

    // Show the extracted plan steps
    const todoListText = state.todoItems
      .map((t, i) => `${i + 1}. ☐ ${t.text}`)
      .join("\n");
    pi.sendMessage(
      {
        customType: "plan-todo-list",
        content: `**Plan Steps (${state.todoItems.length}):**\n\n${todoListText}`,
        display: true,
      },
      { triggerTurn: false },
    );

    // Prompt the user
    const choice = await ctx.ui.select("Plan mode — what next?", [
      "Execute the plan (track progress)",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice?.startsWith("Execute")) {
      // Transition to execution phase
      state = transition(state, { type: "EXECUTE_CHOSEN" });

      await applyModelForPhase(pi, config, state.phase, ctx);
      applyThinkingForPhase(pi, config, state.phase);
      pi.setActiveTools(NORMAL_MODE_TOOLS);

      const firstStep = state.todoItems[0]?.text ?? "the plan";
      pi.sendMessage(
        {
          customType: "plan-mode-execute",
          content: `Execute the plan step by step. Start with: ${firstStep}`,
          display: true,
        },
        { triggerTurn: true },
      );

      updateStatus(ctx);
      persistState();
    } else if (choice === "Refine the plan") {
      // Stay in planning — user provides feedback
      state = transition(state, { type: "REFINE_CHOSEN" });
      updateStatus(ctx);
      persistState();

      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim());
      }
    }
    // "Stay in plan mode" — do nothing, user can keep exploring
  });

  // -----------------------------------------------------------------------
  // Event: restore state on session start / resume
  // -----------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    // Honor --plan flag
    if (pi.getFlag("plan") === true) {
      state = transition(state, { type: "TOGGLE" });
    }

    // Restore persisted state from session entries
    const entries = ctx.sessionManager.getEntries();
    const planModeEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-mode",
      )
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
    if (
      isResume &&
      state.phase === Phase.EXECUTING &&
      state.todoItems.length > 0
    ) {
      // Find the index of the last plan-mode-execute entry
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      // Scan all assistant messages after that marker
      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i] as {
          type: string;
          message?: AgentMessage;
        };
        if (
          entry.type === "message" &&
          entry.message &&
          isAssistantMessage(entry.message)
        ) {
          messages.push(entry.message);
        }
      }

      const allText = messages.map(getTextContent).join("\n");
      markCompletedSteps(allText, state.todoItems);
    }

    // Apply the right tool set for the restored phase
    if (state.phase === Phase.EXECUTING) {
      pi.setActiveTools(NORMAL_MODE_TOOLS);
    } else if (isPlanModeActive(state)) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    }

    updateStatus(ctx);
  });
}
