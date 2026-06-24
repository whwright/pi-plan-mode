# pi-plan-mode — Implementation Plan

This plan is split into 10 phases. Each phase builds on the previous one and can be understood independently.

---

## Phase 1: Project Scaffold & Pure Utilities

**Goal:** Set up the extension directory structure and implement the pure-logic modules that have zero pi dependency.

### Files to create

```
pi-plan-mode/
├── package.json              # Minimal, for npm deps if needed later
├── utils/
│   ├── bash-allowlist.ts     # isSafeCommand()
│   ├── plan-parser.ts        # extractTodoItems(), markCompletedSteps(), cleanStepText()
│   └── index.ts              # Re-export barrel
```

### `utils/bash-allowlist.ts`

Pure functions for bash command safety checking. Port from the existing pi plan-mode example's `utils.ts`:

- `DESTRUCTIVE_PATTERNS: RegExp[]` — Patterns that match destructive commands
- `SAFE_PATTERNS: RegExp[]` — Patterns that match explicitly safe commands
- `isSafeCommand(command: string): boolean` — Returns `true` if command is safe (matches a safe pattern AND doesn't match any destructive pattern)

This is self-contained. No pi imports. Can be unit tested with plain string inputs.

### `utils/plan-parser.ts`

Pure functions for plan text processing:

- `TodoItem { step: number; text: string; completed: boolean }` — Type
- `extractTodoItems(message: string): TodoItem[]` — Find `Plan:` header, parse numbered steps
- `markCompletedSteps(text: string, items: TodoItem[]): number` — Scan for `[DONE:n]` tags, mark matching items complete
- `cleanStepText(text: string): string` — Normalize step text (strip markdown, truncate)

Port from the existing example but keep pure. No pi imports.

### Acceptance criteria
- [ ] `isSafeCommand("ls -la")` → `true`
- [ ] `isSafeCommand("rm -rf /")` → `false`
- [ ] `isSafeCommand("git status")` → `true`
- [ ] `isSafeCommand("git push")` → `false`
- [ ] `extractTodoItems("Plan:\n1. Do X\n2. Do Y")` → 2 TodoItems
- [ ] `markCompletedSteps("did [DONE:1] thing", items)` → marks step 1 complete

---

## Phase 2: Configuration Module

**Goal:** Centralize env var parsing with sensible defaults.

### Files to create

```
pi-plan-mode/
├── config.ts                 # PlanModeConfig type + loadConfig()
```

### `config.ts`

```typescript
interface PlanModeConfig {
  planModel?: { provider: string; modelId: string };
  implModel?: { provider: string; modelId: string };
  planEffort: ThinkingLevel;   // default "xhigh"
  implEffort: ThinkingLevel;   // default "low"
}

function loadConfig(): PlanModeConfig
```

- Reads `PI_PLAN_MODE_PLAN_MODEL`, `PI_PLAN_MODE_IMPL_MODEL`
- Parses `provider/modelId` format
- Reads `PI_PLAN_MODE_PLAN_EFFORT`, `PI_PLAN_MODE_IMPL_EFFORT`
- Validates effort levels against allowed values
- Returns defaults for unset vars

No pi imports — only `process.env` and plain TypeScript.

### Acceptance criteria
- [ ] With no env vars set: returns defaults (planEffort="xhigh", implEffort="low", no model overrides)
- [ ] With `PI_PLAN_MODE_PLAN_MODEL=anthropic/claude-sonnet-4-5`: parses correctly
- [ ] With `PI_PLAN_MODE_PLAN_EFFORT=medium`: overrides plan effort
- [ ] Invalid effort values are rejected or clamped

---

## Phase 3: State Machine

**Goal:** Define the plan mode state machine — phases, transitions, and state shape.

### Files to create

```
pi-plan-mode/
├── state.ts                  # Phase enum, PlanModeState, transition()
```

### `state.ts`

```typescript
enum Phase {
  IDLE = "idle",
  PLANNING = "planning",
  PLAN_READY = "plan_ready",
  EXECUTING = "executing",
}

interface PlanModeState {
  phase: Phase;
  todoItems: TodoItem[];
  previousModel?: ModelSnapshot;    // to restore on exit
  previousEffort?: ThinkingLevel;   // to restore on exit
  previousTools?: string[];         // to restore on exit
}
```

Key function:
```typescript
function transition(state: PlanModeState, event: PlanModeEvent): PlanModeState
```

Events: `TOGGLE`, `PLAN_EXTRACTED`, `EXECUTE_CHOSEN`, `REFINE_CHOSEN`, `ALL_STEPS_DONE`, `CANCEL`

Pure logic — no pi imports. The state machine is testable without pi.

### Acceptance criteria
- [ ] IDLE → (toggle) → PLANNING
- [ ] PLANNING → (plan extracted) → PLAN_READY
- [ ] PLAN_READY → (execute chosen) → EXECUTING
- [ ] PLAN_READY → (refine chosen) → PLAN_READY (stays)
- [ ] EXECUTING → (all steps done) → IDLE
- [ ] Any phase → (toggle off) → IDLE
- [ ] Previous model/effort/tools are restored when leaving plan mode

---

## Phase 4: Extension Entry Point (Skeleton)

**Goal:** Wire up the minimal extension shell — flag, command, shortcut, and state initialization. No phase logic yet, just the skeleton that toggles plan mode on/off.

### Files to create/modify

```
pi-plan-mode/
├── index.ts                  # Extension entry point (build this up over phases)
├── tools.ts                  # Tool set constants
```

### `index.ts` (initial skeleton)

- Register `--plan` flag
- Register `/plan` command (just toggles on/off, no phases yet)
- Register `Ctrl+Alt+P` shortcut
- On `session_start`: check `--plan` flag, restore persisted state
- Footer status indicator: `⏸ plan` when enabled

### `tools.ts`

```typescript
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
```

### Acceptance criteria
- [ ] `pi -e ./index.ts --plan` starts with plan mode active
- [ ] `/plan` toggles plan mode on/off
- [ ] `Ctrl+Alt+P` toggles plan mode
- [ ] Footer shows `⏸ plan` when enabled, clears when disabled
- [ ] Tools are restricted to read-only set when plan mode is on
- [ ] Tools are restored when plan mode is off

---

## Phase 5: Read-Only Exploration (Planning Phase)

**Goal:** Full read-only enforcement — bash allowlist and context injection.

### What to add

- In `tool_call` event: block destructive bash commands in PLANNING phase
- In `before_agent_start`: inject planning context message telling the agent it's in read-only mode and to produce a numbered plan
- In `context` event: filter out stale plan-mode context messages when not in plan mode
- Wire `isSafeCommand()` from `utils/bash-allowlist.ts`

### Context message for planning

```
[PLAN MODE — EXPLORATION]
You are in exploration mode (read-only). Your tools are limited to reading files,
searching code, and running safe bash commands. You CANNOT edit or write files.

Goal: Understand the problem deeply, then produce a detailed numbered plan.

When ready, output your plan under a "Plan:" header:
Plan:
1. First step — what to change and why
2. Second step — what to change and why
...
```

### Acceptance criteria
- [ ] `rm -rf /` is blocked with explanation in planning phase
- [ ] `git push` is blocked
- [ ] `ls`, `grep`, `cat` work normally
- [ ] Agent receives the planning context message
- [ ] Stale context messages are filtered when plan mode is off

---

## Phase 6: Thinking Effort & Model Switching

**Goal:** Apply xhigh thinking during planning, low thinking during execution. Respect env var overrides.

### Files to create

```
pi-plan-mode/
├── thinking.ts               # applyThinkingLevel(), applyModel()
```

### `thinking.ts`

- `applyThinkingLevel(pi, config, phase)` — Set thinking level based on phase and config
- `applyModel(pi, config, phase, ctx)` — Optionally switch model if env var configured
- `snapshotContext(ctx, pi)` — Capture current model, effort, tools before changing
- `restoreContext(pi, snapshot)` — Restore on plan mode exit

### Integration

- On entering PLANNING: snapshot current state, apply plan effort/model
- On entering EXECUTING: apply impl effort/model
- On exiting plan mode (any → IDLE): restore original model/effort/tools

### Acceptance criteria
- [ ] Entering plan mode sets thinking to "xhigh" (default)
- [ ] Entering execution sets thinking to "low" (default)
- [ ] `PI_PLAN_MODE_PLAN_MODEL` changes model for planning phase
- [ ] `PI_PLAN_MODE_IMPL_MODEL` changes model for execution phase
- [ ] `PI_PLAN_MODE_PLAN_EFFORT=high` overrides planning effort
- [ ] Exiting plan mode restores original model and effort
- [ ] Without env vars, only effort changes (model stays the same)

---

## Phase 7: Plan Extraction & Post-Plan Prompt

**Goal:** After the agent finishes in planning mode, extract the numbered plan and prompt the user for next action.

### What to add

In `agent_end` handler (when phase is PLANNING):
1. Scan the last assistant message for a `Plan:` section
2. Use `extractTodoItems()` from `utils/plan-parser.ts`
3. If plan found: transition to PLAN_READY, show plan steps, prompt user
4. Prompt options: "Execute the plan" / "Refine the plan" / "Stay in plan mode"

### User prompt UI

```
┌──────────────────────────────────────────────┐
│ Plan Mode — what next?                       │
│                                              │
│ Plan Steps (5):                              │
│ ☐ 1. Read config module to understand...     │
│ ☐ 2. Add state machine types...              │
│ ☐ 3. Implement transition function...        │
│ ...                                          │
│                                              │
│ > Execute the plan (track progress)          │
│   Refine the plan                            │
│   Stay in plan mode                          │
└──────────────────────────────────────────────┘
```

Use `ctx.ui.select()` for the choices. If "Refine" is chosen, use `ctx.ui.editor()` for input, then `pi.sendUserMessage()` to send refinement as a new prompt.

### Acceptance criteria
- [ ] Agent produces a `Plan:` section → plan is extracted and displayed
- [ ] "Execute the plan" → transitions to EXECUTING, injects execution context
- [ ] "Refine the plan" → opens editor, sends refinement, stays in planning flow
- [ ] "Stay in plan mode" → stays in PLANNING, agent can continue exploring
- [ ] If no plan found, agent can keep exploring (no prompt shown)

---

## Phase 8: Execution Phase & Progress Tracking

**Goal:** Track step completion during execution with `[DONE:n]` markers and a progress widget.

### What to add

- In `turn_end`: scan assistant messages for `[DONE:n]` markers, update todoItems
- Widget showing step completion status (strikethrough for done, checkbox for pending)
- Footer showing `📋 3/7` progress
- On all steps complete: show completion message, transition to IDLE
- Execution context message: tells agent to execute in order and use `[DONE:n]` tags

### Execution context message

```
[EXECUTING PLAN — Step by step]
Execute each step in order. After completing a step, mark it with [DONE:n].

Remaining steps:
3. Add state machine types
4. Implement transition function
...

Do one step at a time. Focus on correctness.
```

### Widget

```
☑ 1. Read config module (done)
☑ 2. Add state machine types (done)
☐ 3. Implement transition function
☐ 4. Test state transitions
☐ 5. Wire into extension
```

### Completion message

When all steps marked done, send a completion message and transition back to IDLE.

### Acceptance criteria
- [ ] Agent writes `[DONE:1]` → step 1 marked complete in widget
- [ ] Widget updates in real-time after each turn
- [ ] Footer shows `📋 3/7` style progress
- [ ] All steps complete → "Plan Complete!" message, back to IDLE
- [ ] Widget clears when leaving execution mode

---

## Phase 9: Session Persistence

**Goal:** Plan mode state survives session restarts and `/resume`.

### What to add

- `persistState(pi, state)` — Called after state changes, uses `pi.appendEntry("plan-mode", ...)`
- `restoreState(entries)` — On `session_start`, scan custom entries for `plan-mode` type, rebuild state
- Re-scan messages after last "plan-mode-execute" marker to rebuild [DONE:n] completion state on resume

### Persisted data shape

```typescript
{
  phase: Phase;
  todos: TodoItem[];
  previousModel?: { provider: string; id: string };
  previousEffort?: ThinkingLevel;
}
```

### Edge cases

- If session is resumed mid-execution: scan all assistant messages after the execution-start marker for `[DONE:n]` tags to rebuild progress
- If phase was PLAN_READY: restore plan items, show widget, but don't re-prompt (user can `/plan` to see options)
- On fresh `/new`: state is cleared naturally (new session)

### Acceptance criteria
- [ ] `/plan`, create plan, execute 2 steps, quit, `/resume` same session → execution continues with correct progress
- [ ] Plan items and completion state are restored correctly
- [ ] Previous model/effort are restored on resume (not re-applied)
- [ ] Fresh session has no stale plan state

---

## Phase 10: Polish & Edge Cases

**Goal:** Handle edge cases, improve UX, add docs.

### Items

- **Error handling:** If model switching fails (no API key), show warning but continue
- **Empty plan:** If agent produces no `Plan:` section, stay in PLANNING, don't prompt
- **Plan mode during streaming:** `/plan` during agent streaming — defer toggle until agent_end
- **Concurrent tool blocking:** Make sure bash allowlist works with parallel tool execution
- **README.md:** Write user-facing documentation
- **Clean up:** Remove debug logging, ensure consistent naming

### Acceptance criteria
- [ ] Graceful fallback when env var model not found
- [ ] Empty plan doesn't crash or show broken prompt
- [ ] Toggling during streaming defers cleanly
- [ ] README is clear and complete
- [ ] All phases work end-to-end: `/plan` → explore → plan → execute → complete

---

## Summary of Files

```
pi-plan-mode/
├── index.ts                  # Extension entry point
├── config.ts                 # Env var configuration
├── state.ts                  # State machine
├── tools.ts                  # Tool set constants & helpers
├── thinking.ts               # Effort level & model management
├── tracking.ts               # Progress widget & status
├── ui.ts                     # User prompts & messages
├── utils/
│   ├── index.ts              # Re-exports
│   ├── bash-allowlist.ts     # isSafeCommand()
│   └── plan-parser.ts        # extractTodoItems(), markCompletedSteps(), cleanStepText()
├── package.json              # Extension metadata
└── README.md                 # User docs
```

---

## Dependency Graph

```
utils/  (no deps)
  └── bash-allowlist.ts
  └── plan-parser.ts

config.ts  (no deps)
state.ts   (depends on plan-parser.ts for TodoItem type)

tools.ts       (depends on pi types)
thinking.ts    (depends on pi types, config.ts, state.ts)
tracking.ts    (depends on pi types, state.ts)
ui.ts          (depends on pi types, state.ts)

index.ts       (depends on everything above — the wiring layer)
```

This layered approach means each module can be understood and tested in isolation before being wired together.