/**
 * Plan mode state machine.
 *
 * Pure logic — no pi dependencies. Defines phases, state shape,
 * and valid transitions. The extension wiring layer reads the state
 * and calls pi APIs accordingly.
 */

import type { TodoItem } from "./utils/plan-parser.js";
import type { ThinkingLevel } from "./config.js";

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export enum Phase {
  /** Plan mode is off. Normal operation. */
  IDLE = "idle",
  /** Read-only exploration. Agent is creating a plan. */
  PLANNING = "planning",
  /** Plan has been extracted from the agent's response. Awaiting user choice. */
  PLAN_READY = "plan_ready",
  /** Executing the plan step by step with full tool access. */
  EXECUTING = "executing",
}

// ---------------------------------------------------------------------------
// Events that drive transitions
// ---------------------------------------------------------------------------

export type PlanModeEvent =
  | { type: "TOGGLE" }
  | { type: "PLAN_EXTRACTED"; items: TodoItem[] }
  | { type: "EXECUTE_CHOSEN" }
  | { type: "REFINE_CHOSEN" }
  | { type: "ALL_STEPS_DONE" };

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/** A lightweight snapshot of the current model for restoration on exit. */
export interface ModelSnapshot {
  provider: string;
  id: string;
}

export interface PlanModeState {
  phase: Phase;
  todoItems: TodoItem[];

  /** Saved model before plan mode was activated. Restored on exit. */
  previousModel?: ModelSnapshot;
  /** Saved thinking effort before plan mode. Restored on exit. */
  previousEffort?: ThinkingLevel;
  /** Saved active tool names before plan mode. Restored on exit. */
  previousTools?: string[];
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createInitialState(): PlanModeState {
  return {
    phase: Phase.IDLE,
    todoItems: [],
  };
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

interface Transition {
  from: Phase[];
  to: Phase;
  guard?: (state: PlanModeState, event: PlanModeEvent) => boolean;
  update?: (state: PlanModeState, event: PlanModeEvent) => Partial<PlanModeState>;
}

const transitions: Transition[] = [
  // Toggle: IDLE → PLANNING
  {
    from: [Phase.IDLE],
    to: Phase.PLANNING,
    guard: (_s, e) => e.type === "TOGGLE",
  },
  // Toggle: any active phase → IDLE
  {
    from: [Phase.PLANNING, Phase.PLAN_READY, Phase.EXECUTING],
    to: Phase.IDLE,
    guard: (_s, e) => e.type === "TOGGLE",
    update: () => ({ todoItems: [] }),
  },

  // Agent produced a plan → PLAN_READY
  {
    from: [Phase.PLANNING, Phase.PLAN_READY],
    to: Phase.PLAN_READY,
    guard: (_s, e) => e.type === "PLAN_EXTRACTED",
    update: (_s, e) =>
      e.type === "PLAN_EXTRACTED" ? { todoItems: e.items } : {},
  },

  // User chose to execute → EXECUTING
  {
    from: [Phase.PLAN_READY],
    to: Phase.EXECUTING,
    guard: (_s, e) => e.type === "EXECUTE_CHOSEN",
  },

  // User chose to refine → back to PLANNING for another round
  {
    from: [Phase.PLAN_READY, Phase.PLANNING],
    to: Phase.PLANNING,
    guard: (_s, e) => e.type === "REFINE_CHOSEN",
  },

  // All steps done → IDLE
  {
    from: [Phase.EXECUTING],
    to: Phase.IDLE,
    guard: (_s, e) => e.type === "ALL_STEPS_DONE",
    update: () => ({ todoItems: [] }),
  },
];

// ---------------------------------------------------------------------------
// Transition function
// ---------------------------------------------------------------------------

/**
 * Compute the next state given a current state and an event.
 * Returns the new state if the transition is valid, or the original state
 * if no transition matches.
 */
export function transition(
  state: PlanModeState,
  event: PlanModeEvent,
): PlanModeState {
  for (const t of transitions) {
    if (!t.from.includes(state.phase)) continue;
    if (t.guard && !t.guard(state, event)) continue;

    const updates: Partial<PlanModeState> = { phase: t.to };
    if (t.update) {
      Object.assign(updates, t.update(state, event));
    }
    return { ...state, ...updates };
  }

  // No matching transition — state unchanged
  return state;
}

// ---------------------------------------------------------------------------
// Convenience queries
// ---------------------------------------------------------------------------

export function isPlanModeActive(state: PlanModeState): boolean {
  return state.phase !== Phase.IDLE;
}

export function isReadOnly(state: PlanModeState): boolean {
  return state.phase === Phase.PLANNING;
}

export function isExecuting(state: PlanModeState): boolean {
  return state.phase === Phase.EXECUTING;
}