/**
 * Tool set constants and helpers.
 * Defines which tools are available in each plan mode phase.
 */

/** Read-only tools available during the planning / exploration phase. */
export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

/** Full-access tools available during normal operation and execution phase. */
export const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
