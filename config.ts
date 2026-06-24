/**
 * Plan mode configuration from environment variables.
 *
 * All variables are optional. When unset, plan mode only changes the
 * thinking effort level — it keeps the session's current model.
 *
 * Environment variables:
 *   PI_PLAN_MODE_PLAN_MODEL   — Model during planning (format: provider/modelId)
 *   PI_PLAN_MODE_IMPL_MODEL   — Model during execution (format: provider/modelId)
 *   PI_PLAN_MODE_PLAN_EFFORT  — Thinking effort during planning (default: "xhigh")
 *   PI_PLAN_MODE_IMPL_EFFORT  — Thinking effort during execution (default: "low")
 *
 * No pi dependencies — only reads process.env.
 */

/** Thinking effort levels supported by pi. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const VALID_EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** A parsed model reference: provider and model ID. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** Resolved configuration with all defaults applied. */
export interface PlanModeConfig {
  /** Model override for the planning phase, or undefined to keep current. */
  planModel?: ModelRef;
  /** Model override for the execution phase, or undefined to keep current. */
  implModel?: ModelRef;
  /** Thinking effort during planning (defaults to "xhigh"). */
  planEffort: ThinkingLevel;
  /** Thinking effort during execution (defaults to "low"). */
  implEffort: ThinkingLevel;
}

/** Default thinking levels when no env vars are set. */
const DEFAULT_PLAN_EFFORT: ThinkingLevel = "xhigh";
const DEFAULT_IMPL_EFFORT: ThinkingLevel = "low";

/**
 * Parse a "provider/modelId" string into a ModelRef.
 * Returns undefined if the string is empty or malformed.
 */
function parseModelRef(raw: string | undefined): ModelRef | undefined {
  if (!raw || raw.trim().length === 0) return undefined;

  const slashIdx = raw.indexOf("/");
  if (slashIdx <= 0 || slashIdx === raw.length - 1) {
    // Malformed — must be "provider/modelId"
    console.warn(`[pi-plan-mode] Invalid model format "${raw}". Expected "provider/modelId".`);
    return undefined;
  }

  return {
    provider: raw.slice(0, slashIdx).trim(),
    modelId: raw.slice(slashIdx + 1).trim(),
  };
}

/**
 * Parse and validate a thinking effort level from an env var.
 * Returns the parsed level or undefined if not set / invalid.
 */
function parseEffort(raw: string | undefined): ThinkingLevel | undefined {
  if (!raw || raw.trim().length === 0) return undefined;

  const normalized = raw.trim().toLowerCase();
  if (!VALID_EFFORT_LEVELS.has(normalized)) {
    console.warn(
      `[pi-plan-mode] Invalid effort level "${raw}". Valid: ${[...VALID_EFFORT_LEVELS].join(", ")}.`,
    );
    return undefined;
  }

  return normalized as ThinkingLevel;
}

/**
 * Load the plan mode configuration from environment variables.
 * All fields have sensible defaults — only effort levels change by default.
 */
export function loadConfig(): PlanModeConfig {
  return {
    planModel: parseModelRef(process.env.PI_PLAN_MODE_PLAN_MODEL),
    implModel: parseModelRef(process.env.PI_PLAN_MODE_IMPL_MODEL),
    planEffort: parseEffort(process.env.PI_PLAN_MODE_PLAN_EFFORT) ?? DEFAULT_PLAN_EFFORT,
    implEffort: parseEffort(process.env.PI_PLAN_MODE_IMPL_EFFORT) ?? DEFAULT_IMPL_EFFORT,
  };
}