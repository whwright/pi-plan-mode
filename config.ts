/**
 * Plan mode configuration.
 *
 * Defaults: current model, xhigh thinking for planning, low for execution.
 * Override via /plan-settings — settings persist to
 * ~/.pi/agent/extensions/pi-plan-mode/config.json and survive all sessions.
 *
 * Priority: config.json > defaults.
 */

import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Thinking effort levels supported by pi. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const EFFORT_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** A parsed model reference: provider and model ID. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** Runtime-mutable configuration. */
export interface PlanPreset {
  planModel?: ModelRef;
  implModel?: ModelRef;
  planEffort: ThinkingLevel;
  implEffort: ThinkingLevel;
}

export interface PlanModeConfig {
  /** Model override for the planning phase, or undefined to keep current. */
  planModel?: ModelRef;
  /** Model override for the execution phase, or undefined to keep current. */
  implModel?: ModelRef;
  /** Thinking effort during planning (defaults to "xhigh"). */
  planEffort: ThinkingLevel;
  /** Thinking effort during execution (defaults to "low"). */
  implEffort: ThinkingLevel;
  /** Named combinations of phase models and thinking levels. */
  presets: Record<string, PlanPreset>;
  /** Open drafted plans in Plannotator for browser review (defaults to true). */
  plannotatorReview: boolean;
}

/** JSON-serializable form of the config for persistence. */
export interface SerializedConfig {
  planModel?: { provider: string; modelId: string } | null;
  implModel?: { provider: string; modelId: string } | null;
  planEffort?: ThinkingLevel;
  implEffort?: ThinkingLevel;
  presets?: Record<string, SerializedPreset>;
  plannotatorReview?: boolean;
}

interface SerializedPreset {
  planModel?: { provider: string; modelId: string } | null;
  implModel?: { provider: string; modelId: string } | null;
  planEffort: ThinkingLevel;
  implEffort: ThinkingLevel;
}

/** Path to the persisted settings file. */
const CONFIG_PATH = `${homedir()}/.pi/agent/extensions/pi-plan-mode/config.json`;

/** Default thinking levels. */
const DEFAULT_PLAN_EFFORT: ThinkingLevel = "xhigh";
const DEFAULT_IMPL_EFFORT: ThinkingLevel = "low";

/**
 * Create a new configuration with sensible defaults.
 * Call /plan-settings to override, loadConfigFromFile to restore.
 */
export function createPlanModeConfig(): PlanModeConfig {
  const envReview = process.env.PI_PLAN_MODE_PLANNOTATOR_REVIEW;
  const plannotatorReview = envReview === undefined
    ? true
    : !(envReview === "0" || envReview.toLowerCase() === "false");
  return {
    planEffort: DEFAULT_PLAN_EFFORT,
    implEffort: DEFAULT_IMPL_EFFORT,
    presets: {},
    plannotatorReview,
  };
}

/**
 * Load persisted settings from ~/.pi/agent/extensions/pi-plan-mode/config.json
 * and apply them on top of a live config. Returns true if file was loaded.
 */
export async function loadConfigFromFile(config: PlanModeConfig): Promise<boolean> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const data = JSON.parse(raw) as Partial<SerializedConfig>;
    applySerializedConfig(config, data);
    return true;
  } catch {
    // File doesn't exist or is unreadable — that's fine, keep defaults.
    return false;
  }
}

/**
 * Write the current config to ~/.pi/agent/extensions/pi-plan-mode/config.json.
 */
export async function saveConfigToFile(config: PlanModeConfig): Promise<void> {
  const dir = dirname(CONFIG_PATH);
  await mkdir(dir, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(serializeConfig(config), null, 2), "utf-8");
}

/** Serialize config to a JSON-safe object for file persistence. */
export function serializeConfig(config: PlanModeConfig): SerializedConfig {
  return {
    planModel: config.planModel ? { provider: config.planModel.provider, modelId: config.planModel.modelId } : null,
    implModel: config.implModel ? { provider: config.implModel.provider, modelId: config.implModel.modelId } : null,
    planEffort: config.planEffort,
    implEffort: config.implEffort,
    presets: Object.fromEntries(
      Object.entries(config.presets).map(([name, preset]) => [name, serializePreset(preset)]),
    ),
    plannotatorReview: config.plannotatorReview,
  };
}

/** Apply persisted settings on top of a live config. Only defined keys are merged. */
export function applySerializedConfig(config: PlanModeConfig, data: Partial<SerializedConfig>): void {
  if (data.planModel !== undefined) {
    config.planModel = data.planModel ? { ...data.planModel } : undefined;
  }
  if (data.implModel !== undefined) {
    config.implModel = data.implModel ? { ...data.implModel } : undefined;
  }
  if (data.planEffort !== undefined) {
    config.planEffort = data.planEffort;
  }
  if (data.implEffort !== undefined) {
    config.implEffort = data.implEffort;
  }
  if (data.presets !== undefined && data.presets && typeof data.presets === "object" && !Array.isArray(data.presets)) {
    config.presets = Object.fromEntries(
      Object.entries(data.presets)
        .filter(([name, preset]) => name.trim().length > 0 && isValidPreset(preset))
        .map(([name, preset]) => [name, clonePreset(preset as PlanPreset)]),
    );
  }
  if (data.plannotatorReview !== undefined) {
    config.plannotatorReview = data.plannotatorReview;
  }
}

function serializePreset(preset: PlanPreset): SerializedPreset {
  return {
    planModel: preset.planModel ? { ...preset.planModel } : null,
    implModel: preset.implModel ? { ...preset.implModel } : null,
    planEffort: preset.planEffort,
    implEffort: preset.implEffort,
  };
}

function clonePreset(preset: PlanPreset): PlanPreset {
  return {
    ...preset,
    planModel: preset.planModel ? { ...preset.planModel } : undefined,
    implModel: preset.implModel ? { ...preset.implModel } : undefined,
  };
}

function isValidPreset(value: unknown): value is SerializedPreset {
  if (!value || typeof value !== "object") return false;
  const preset = value as Partial<SerializedPreset>;
  return EFFORT_LEVELS.includes(preset.planEffort as ThinkingLevel) &&
    EFFORT_LEVELS.includes(preset.implEffort as ThinkingLevel) &&
    (preset.planModel === null || preset.planModel === undefined || validModel(preset.planModel)) &&
    (preset.implModel === null || preset.implModel === undefined || validModel(preset.implModel));
}

function validModel(value: unknown): value is ModelRef {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ModelRef>;
  return typeof model.provider === "string" && model.provider.length > 0 &&
    typeof model.modelId === "string" && model.modelId.length > 0;
}
