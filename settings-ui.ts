/**
 * Interactive plan mode settings UI.
 *
 * Provides the /plan-settings command flow: a main menu letting the user
 * choose plan model, plan thinking effort, implementation model, and
 * implementation thinking effort. Model selection uses a searchable
 * SelectList with filter-as-you-type.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

import {
  EFFORT_LEVELS,
  type ModelRef,
  type PlanModeConfig,
  type ThinkingLevel,
} from "./config.js";

/** Sentinel value for "keep current model" in the SelectList. */
const KEEP_CURRENT = "__keep_current__";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modelLabel(m: ModelRef | undefined): string {
  if (!m) return "current model";
  return `${m.provider}/${m.modelId}`;
}

function modelRefFromSelect(value: string): ModelRef | undefined {
  if (!value || value === KEEP_CURRENT) return undefined;
  const slashIdx = value.indexOf("/");
  if (slashIdx <= 0) return undefined;
  return {
    provider: value.slice(0, slashIdx),
    modelId: value.slice(slashIdx + 1),
  };
}

function modelSelectValue(m: ModelRef | undefined): string {
  if (!m) return KEEP_CURRENT;
  return `${m.provider}/${m.modelId}`;
}

// ---------------------------------------------------------------------------
// Effort level helpers — model-aware filtering
// ---------------------------------------------------------------------------

function supportedLevels(model: Model<Api> | undefined): ThinkingLevel[] {
  if (!model) return [...EFFORT_LEVELS];

  // Keep this list in lockstep with pi's built-in thinking selector. In
  // particular, omitted map entries do not mean that every level is valid:
  // pi treats xhigh/max as unsupported unless they are explicitly mapped.
  return getSupportedThinkingLevels(model).filter(
    (level): level is ThinkingLevel => EFFORT_LEVELS.includes(level as ThinkingLevel),
  );
}

/**
 * Clamp an effort level to the nearest supported level.
 * Searches downward from the current level's position in EFFORT_LEVELS;
 * if nothing below is supported, returns the highest supported level.
 */
function clampLevel(level: ThinkingLevel, supported: ThinkingLevel[]): ThinkingLevel {
  if (supported.includes(level)) return level;
  const idx = EFFORT_LEVELS.indexOf(level);
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i];
  }
  return supported[supported.length - 1];
}

/**
 * Resolve the model to consult for effort-level availability.
 *
 * If the caller has configured a model override for the phase, look it up in
 * the registry.  Otherwise fall back to the current session model.
 */
function resolveEffortModel(
  ctx: ExtensionCommandContext,
  modelRef: ModelRef | undefined,
): Model<Api> | undefined {
  if (modelRef) {
    const model = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
    if (model) return model;
  }
  return ctx.model;
}

// ---------------------------------------------------------------------------
// Effort picker — model-aware ctx.ui.select dialog
// ---------------------------------------------------------------------------

async function pickEffort(
  ctx: ExtensionCommandContext,
  label: string,
  current: ThinkingLevel,
  model?: Model<Api>,
): Promise<ThinkingLevel | null> {
  const supported = supportedLevels(model);
  const clamped = clampLevel(current, supported);

  const choices = supported.map((lvl) => {
    const marker = lvl === clamped ? " ✓" : "";
    return `${lvl}${marker}`;
  });

  const choice = await ctx.ui.select(`Select ${label}:`, choices);
  if (!choice) return null;

  // Strip the checkmark suffix
  const level = choice.replace(/\s*✓$/, "").trim() as ThinkingLevel;
  return level;
}

// ---------------------------------------------------------------------------
// Fuzzy match — checks if pattern characters appear in order within text
// ---------------------------------------------------------------------------

function fuzzyMatch(pattern: string, text: string): boolean {
  let pi = 0;
  for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
    if (text[ti] === pattern[pi]) pi++;
  }
  return pi === pattern.length;
}

// ---------------------------------------------------------------------------
// Model picker — overlay with fuzzy-filterable SelectList
// ---------------------------------------------------------------------------

async function pickModel(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  label: string,
  current: ModelRef | undefined,
): Promise<ModelRef | undefined | null> {
  // Gather available models
  let availableModels: Array<{ provider: string; id: string; name?: string }> = [];

  try {
    const reg = ctx.modelRegistry as unknown as {
      getAvailable?: () => Promise<Array<{ provider: string; id: string; name?: string }>>;
    };
    if (typeof reg.getAvailable === "function") {
      availableModels = await reg.getAvailable();
    }
  } catch {
    // Fall through — show only "keep current" if models can't be enumerated.
  }

  // Build SelectItems: "Keep current" first, then all available models
  const currentValue = modelSelectValue(current);
  const allItems: SelectItem[] = [
    {
      value: KEEP_CURRENT,
      label: "Keep current model",
      description: `Use the session's active model${current ? ` (currently ${modelLabel(current)})` : ""}`,
    },
  ];

  for (const m of availableModels) {
    const value = `${m.provider}/${m.id}`;
    allItems.push({
      value,
      label: m.id,
      description: m.provider,
    });
  }

  // Pre-select the current model if it's in the list
  let selectedIndex = 0;
  if (current) {
    const idx = allItems.findIndex((it) => it.value === currentValue);
    if (idx >= 0) selectedIndex = idx;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let filterText = "";

    const container = new Container();

    // Top border
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    // Title
    container.addChild(
      new Text(theme.fg("accent", theme.bold(`Select ${label}`)), 1, 0),
    );

    // Filter indicator (hidden when empty)
    const filterLine = new Text("", 1, 0);
    container.addChild(filterLine);

    function applyFuzzyFilter(items: SelectItem[], filter: string): SelectItem[] {
      if (filter.length === 0) return items;
      const lower = filter.toLowerCase();
      return items.filter((item) => {
        const searchText = `${item.value} ${item.label}`.toLowerCase();
        return fuzzyMatch(lower, searchText);
      });
    }

    const filtered = applyFuzzyFilter(allItems, filterText);

    // SelectList with theme
    const selectList = new SelectList(filtered, Math.min(filtered.length + 2, 15), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    // Jump to the currently-selected item
    for (let i = 0; i < selectedIndex && i < filtered.length; i++) {
      selectList.handleInput?.("\x1b[B"); // down arrow
    }

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    // Help text
    container.addChild(
      new Text(theme.fg("dim", "↑↓ navigate • type to fuzzy-find • enter select • esc cancel"), 1, 0),
    );

    // Bottom border
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Printable character → add to filter
        if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
          filterText += data;
        }
        // Backspace → remove last character
        else if (data === "\x7f" || data === "\b") {
          filterText = filterText.slice(0, -1);
        }
        // Navigation, enter, escape → pass to SelectList
        else {
          selectList.handleInput?.(data);
          tui.requestRender();
          return;
        }

        // Update filter indicator
        if (filterText.length > 0) {
          filterLine.setText(
            theme.fg("muted", `Filter: `) + theme.fg("accent", filterText) + theme.fg("dim", "█"),
          );
        } else {
          filterLine.setText("");
        }

        // Rebuild SelectList with fuzzy-filtered items
        const newFiltered = applyFuzzyFilter(allItems, filterText);
        // Directly patch the SelectList internals since there's no public API
        // to replace items after construction.
        const sl = selectList as unknown as { filteredItems: SelectItem[]; selectedIndex: number };
        sl.filteredItems = newFiltered;
        sl.selectedIndex = 0;
        selectList.invalidate();
        container.invalidate();
        tui.requestRender();
      },
    };
  });

  if (result === null) return null; // cancelled
  return modelRefFromSelect(result);
}

// ---------------------------------------------------------------------------
// Main settings loop
// ---------------------------------------------------------------------------

/**
 * Show the interactive plan mode settings flow.
 * Returns a new PlanModeConfig with the user's choices applied.
 * Returns the original config if the user cancels (Escape).
 */
export async function showPlanSettings(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  config: PlanModeConfig,
): Promise<PlanModeConfig> {
  // Work on a copy so cancelling mid-flow doesn't mutate the live config
  const draft: PlanModeConfig = {
    planModel: config.planModel ? { ...config.planModel } : undefined,
    implModel: config.implModel ? { ...config.implModel } : undefined,
    planEffort: config.planEffort,
    implEffort: config.implEffort,
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const choices = [
      `Plan thinking:   ${draft.planEffort}`,
      `Plan model:      ${modelLabel(draft.planModel)}`,
      `Impl thinking:   ${draft.implEffort}`,
      `Impl model:      ${modelLabel(draft.implModel)}`,
      "💾 Save and close",
    ];

    const choice = await ctx.ui.select("Plan mode settings — choose a setting to change:", choices);

    // Cancelled or "Save and close"
    if (!choice || choice.startsWith("💾")) break;

    if (choice.startsWith("Plan thinking")) {
      const caps = resolveEffortModel(ctx, draft.planModel);
      const level = await pickEffort(ctx, "plan thinking effort", draft.planEffort, caps);
      if (level) draft.planEffort = level;
    } else if (choice.startsWith("Plan model")) {
      const model = await pickModel(ctx, pi, "plan model", draft.planModel);
      if (model !== null) {
        draft.planModel = model;
        // Re-clamp plan effort in case the new model has narrower support
        const caps = resolveEffortModel(ctx, draft.planModel);
        const supported = supportedLevels(caps);
        draft.planEffort = clampLevel(draft.planEffort, supported);
      }
    } else if (choice.startsWith("Impl thinking")) {
      const caps = resolveEffortModel(ctx, draft.implModel);
      const level = await pickEffort(ctx, "implementation thinking effort", draft.implEffort, caps);
      if (level) draft.implEffort = level;
    } else if (choice.startsWith("Impl model")) {
      const model = await pickModel(ctx, pi, "implementation model", draft.implModel);
      if (model !== null) {
        draft.implModel = model;
        // Re-clamp impl effort in case the new model has narrower support
        const caps = resolveEffortModel(ctx, draft.implModel);
        const supported = supportedLevels(caps);
        draft.implEffort = clampLevel(draft.implEffort, supported);
      }
    }
  }

  return draft;
}