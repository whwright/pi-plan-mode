/**
 * Thinking effort and model switching for plan mode phases.
 *
 * Handles applying the correct thinking level and model based on the
 * current phase and user configuration. Respects env var overrides.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PlanModeConfig } from "./config.js";
import { Phase } from "./state.js";

/**
 * Apply the thinking effort level appropriate for the current phase.
 * Uses config defaults (xhigh for planning, low for executing) or
 * user-configured overrides from env vars.
 */
export function applyThinkingForPhase(
  pi: ExtensionAPI,
  config: PlanModeConfig,
  phase: Phase,
): void {
  switch (phase) {
    case Phase.PLANNING:
    case Phase.PLAN_READY:
      pi.setThinkingLevel(config.planEffort);
      break;
    case Phase.EXECUTING:
      pi.setThinkingLevel(config.implEffort);
      break;
    case Phase.IDLE:
      // Thinking level is restored by the caller from the snapshot.
      break;
  }
}

/**
 * Optionally switch the model for the current phase.
 * Only switches if the user configured a model override via env vars.
 * Returns true if a model switch was attempted (even if it failed).
 */
export async function applyModelForPhase(
  pi: ExtensionAPI,
  config: PlanModeConfig,
  phase: Phase,
  ctx: ExtensionContext,
): Promise<boolean> {
  const modelRef =
    phase === Phase.EXECUTING ? config.implModel : config.planModel;

  // No override configured — keep the session's current model.
  if (!modelRef) return false;

  const model = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
  if (!model) {
    ctx.ui.notify(
      `Plan mode: model "${modelRef.provider}/${modelRef.modelId}" not found. ` +
        `Keeping current model.`,
      "warning",
    );
    return false;
  }

  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify(
      `Plan mode: no API key for "${modelRef.provider}/${modelRef.modelId}". ` +
        `Keeping current model.`,
      "warning",
    );
    return false;
  }

  return true;
}