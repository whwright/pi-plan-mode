# pi-plan-mode — Architecture

## Overview

A pi extension that adds a structured plan mode with two distinct phases:

1. **Exploration (Planning)** — Read-only, xhigh thinking. The agent explores code, asks questions, and produces a numbered plan.
2. **Execution (Implementing)** — Full write access, low thinking. The agent executes the plan step-by-step with progress tracking.

Default behavior only changes the **thinking effort level** (xhigh ↔ low), keeping the session's current model. Model and effort can be overridden per phase via environment variables.

---

## Design Principles

### 1. Modular — Separate pi wiring from pure logic

| Layer | What it contains | Depends on pi? |
|-------|-----------------|----------------|
| **Pure utilities** (`utils/`) | Bash allowlist, plan parsing, text cleaning | No — plain functions |
| **Configuration** (`config.ts`) | Env var parsing, config object | No — just reads `process.env` |
| **State** (`state.ts`) | State machine, types, transitions | No — plain data |
| **Extension wiring** (`index.ts`) | Event handlers, tool management, UI | Yes — uses `ExtensionAPI` |

This makes it easy to understand what is "plan mode logic" vs what is "glue code to make pi do things."

### 2. Incrementally testable

Each pure-utility function can be tested in isolation. The state machine can be tested without pi. Only the wiring layer needs a running pi instance.

### 3. Defaults are zero-config

By default, plan mode changes **only the thinking effort level**. No model switching, no extra configuration. Users opt into overrides via env vars.

---

## Module Map

```
pi-plan-mode/
├── index.ts                 # Extension entry point. Registers events, commands,
│                            # shortcuts, flag. Wires everything together.
├── config.ts                # Reads PI_PLAN_MODE_* env vars, produces a
│                            # PlanModeConfig object with defaults.
├── state.ts                 # State machine: Phase enum, PlanModeState type,
│                            # transition function, guard checks.
├── utils/
│   ├── bash-allowlist.ts    # isSafeCommand(command: string): boolean
│   │                        # SAFE_PATTERNS, DESTRUCTIVE_PATTERNS regex arrays
│   └── plan-parser.ts       # extractTodoItems(text): TodoItem[]
│   │                        # markCompletedSteps(text, items): number
│   │                        # cleanStepText(text): string
│   └── index.ts             # Re-exports
├── tools.ts                 # PLAN_MODE_TOOLS, NORMAL_MODE_TOOLS constants
│                            # applyToolSet(pi, phase) helper
├── thinking.ts              # applyThinkingLevel(pi, config, phase) helper
│                            # applyModel(pi, config, phase, ctx) helper
├── tracking.ts              # updateStatus(ctx, state) — footer + widget
│                            # persistState(pi, state) — session persistence
│                            # restoreState(pi, ctx) — on session_start
└── ui.ts                    # showPostPlanPrompt(ctx, state) — execute/refine/stay
                             # showCompletionMessage(pi, state)
```

---

## State Machine

```
                  /plan
                    │
    ┌───────────────▼───────────────┐
    │           PLANNING            │  read-only tools
    │   (xhigh thinking by default) │  bash allowlist
    │                              │
    └───────────────┬──────────────┘
                    │ agent_end fires,
                    │ plan extracted
                    │
    ┌───────────────▼───────────────┐
    │         PLAN_READY            │  plan steps extracted
    │   (xhigh thinking by default) │  user prompted: execute/refine/stay
    │                              │
    └──┬──────────────┬────────────┘
       │              │
       │ "Execute"    │ "Refine"
       │              │
       ▼              ▼
    ┌──────────┐   ┌──────────────┐
    │EXECUTING │   │ stays in     │  user's refinement text
    │ low      │   │ PLAN_READY,  │  sent as new prompt →
    │ thinking │   │ re-extracts  │  back to PLANNING flow
    │ full     │   │ plan on next │
    │ tools    │   │ agent_end    │
    └────┬─────┘   └──────────────┘
         │
         │ all [DONE:n] seen
         ▼
    ┌──────────┐
    │ COMPLETE │  success message,
    │          │  transition to IDLE
    └──────────┘
```

Phases:
- `IDLE` — Plan mode off
- `PLANNING` — Read-only exploration, plan creation
- `PLAN_READY` — Plan extracted, awaiting user decision
- `EXECUTING` — Implementing the plan step by step
- `COMPLETE` — All steps done, transitioning back to IDLE

---

## Configuration (Env Vars)

All optional. When unset, plan mode only changes thinking effort.

| Variable | Purpose | Default |
|----------|---------|---------|
| `PI_PLAN_MODE_PLAN_MODEL` | Model during planning phase | (current session model) |
| `PI_PLAN_MODE_IMPL_MODEL` | Model during execution phase | (current session model) |
| `PI_PLAN_MODE_PLAN_EFFORT` | Thinking effort during planning | `"xhigh"` |
| `PI_PLAN_MODE_IMPL_EFFORT` | Thinking effort during execution | `"low"` |

Format for `*_MODEL`: `provider/modelId` (e.g., `anthropic/claude-sonnet-4-5`).

Format for `*_EFFORT`: `off | minimal | low | medium | high | xhigh`.

---

## Key pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerFlag("plan", ...)` | `--plan` CLI flag to start in plan mode |
| `pi.registerCommand("plan", ...)` | `/plan` command to toggle plan mode |
| `pi.registerShortcut(...)` | `Ctrl+Alt+P` to toggle |
| `pi.on("tool_call", ...)` | Block destructive bash commands in planning |
| `pi.on("before_agent_start", ...)` | Inject phase-specific context message |
| `pi.on("turn_end", ...)` | Scan for [DONE:n] markers, update progress |
| `pi.on("agent_end", ...)` | Extract plan, prompt user for next action |
| `pi.on("session_start", ...)` | Restore persisted state, `--plan` flag |
| `pi.on("context", ...)` | Filter stale plan-mode context messages |
| `pi.setActiveTools(...)` | Switch between read-only and full tool sets |
| `pi.setThinkingLevel(...)` | xhigh for planning, low for executing |
| `pi.setModel(...)` | Optional model switching per phase |
| `pi.getThinkingLevel()` | Snapshot current level before changing |
| `pi.appendEntry(...)` | Persist state across session restarts |
| `pi.sendMessage(...)` | Inject progress messages |
| `pi.sendUserMessage(...)` | Trigger turns for refinement |
| `pi.getFlag("plan")` | Check `--plan` flag on startup |
| `ctx.ui.setStatus(...)` | Footer status indicator |
| `ctx.ui.setWidget(...)` | Progress widget above editor |
| `ctx.ui.select(...)` | Post-plan user prompt |
| `ctx.ui.editor(...)` | Refinement text input |
| `ctx.ui.notify(...)` | Notifications |
| `ctx.modelRegistry.find(...)` | Find model for optional overrides |
| `ctx.model` | Snapshot current model before switching |

---

## Separation of Concerns

### What goes in pure utilities (no pi imports)

- `bash-allowlist.ts` — Regex arrays and `isSafeCommand()`. This is just string matching.
- `plan-parser.ts` — `extractTodoItems()`, `markCompletedSteps()`, `cleanStepText()`. These operate on plain strings and plain objects.

### What goes in config (no pi imports, just env)

- `config.ts` — Reads `process.env`, returns a typed config object with defaults. No pi dependency.

### What goes in state (no pi imports)

- `state.ts` — The `Phase` enum, `PlanModeState` interface, `transition()` function. Pure logic.

### What goes in the extension wiring (uses pi)

- `index.ts` — All event registrations, command handlers, shortcut handlers.
- `tools.ts` — Tool-set constants and `applyToolSet()` (calls `pi.setActiveTools`).
- `thinking.ts` — `applyThinkingLevel()` (calls `pi.setThinkingLevel`), `applyModel()` (calls `pi.setModel`).
- `tracking.ts` — Widget/status updates (calls `ctx.ui.*`), persistence (calls `pi.appendEntry`).
- `ui.ts` — User prompts (calls `ctx.ui.select`, `ctx.ui.editor`), messages (calls `pi.sendMessage`).