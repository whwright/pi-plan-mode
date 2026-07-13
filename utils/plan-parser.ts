/**
 * Pure utility: Plan text parsing.
 * No pi dependencies — operates on plain strings and plain objects.
 */

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

/**
 * Clean and normalize a plan step's text.
 * Strips markdown formatting, leading action verbs, and truncates.
 */
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
    .replace(/`([^`]+)`/g, "$1") // Remove inline code
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }
  return cleaned;
}

/**
 * Extract numbered todo items from a "Plan" section in the LLM's response.
 * Matches various heading formats: "Plan:", "## Plan", "**Plan:**", etc.
 * Then looks for numbered steps like "1. Do X" or "1) Do X".
 */
export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];

  // Match a "Plan" header line — supports optional markdown heading (#, ##, ###),
  // optional bold markers, and optional colon.
  const headerMatch = message.match(/(?:^|\n)#{0,3}\s*\*{0,2}Plan:?\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    // Filter out obviously non-step lines
    if (text.length > 2 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({ step: items.length + 1, text: cleaned, completed: false });
      }
    }
  }
  return items;
}

/**
 * Scan text for [DONE:n] markers and return the step numbers found.
 */
export function extractDoneSteps(text: string): number[] {
  const steps: number[] = [];
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/**
 * Mark todo items as completed based on [DONE:n] markers found in the text.
 * Returns the number of items that were newly marked complete.
 */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
  let count = 0;
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item && !item.completed) {
      item.completed = true;
      count++;
    }
  }
  return count;
}