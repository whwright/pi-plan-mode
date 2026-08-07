/**
 * Client for Plannotator's shared Pi event bus.
 *
 * Communicates with the sibling @plannotator/pi-extension over `pi.events`
 * using plain string channels — no npm dependency on Plannotator itself.
 * Every call is timeout-guarded: when Plannotator is not installed the
 * request simply goes unanswered and the caller falls back gracefully.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Channels & timeout (mirrors @plannotator/pi-extension/plannotator-events)
// ---------------------------------------------------------------------------

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
export const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result";
export const PLANNOTATOR_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Minimal local type copies (the channels are plain strings by design)
// ---------------------------------------------------------------------------

export type PlannotatorResponse<T> =
  | { status: "handled"; result: T }
  | { status: "unavailable"; error?: string }
  | { status: "error"; error: string };

export interface PlannotatorPlanReviewStartResult {
  status: "pending";
  reviewId: string;
}

export interface PlannotatorReviewResultEvent {
  reviewId: string;
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
}

export type PlannotatorReviewStatusResult =
  | { status: "pending" }
  | ({ status: "completed" } & PlannotatorReviewResultEvent)
  | { status: "missing" };

interface PlannotatorRequest<A, P, R> {
  requestId: string;
  action: A;
  payload: P;
  respond: (response: PlannotatorResponse<R>) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a request on the shared bus and await `respond`, with a timeout. */
function emitRequest<A, P, R>(
  pi: ExtensionAPI,
  action: A,
  payload: P,
): Promise<PlannotatorResponse<R> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), PLANNOTATOR_TIMEOUT_MS);
    const request: PlannotatorRequest<A, P, R> = {
      requestId: crypto.randomUUID(),
      action,
      payload,
      respond: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    };
    pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, request);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask Plannotator to open a plan review in the browser.
 * Resolves to the reviewId when the review was started, or null when
 * Plannotator is absent, unavailable, or errored (caller should fall back).
 */
export async function requestPlanReview(
  pi: ExtensionAPI,
  planContent: string,
): Promise<{ reviewId: string } | null> {
  const response = await emitRequest<"plan-review", { planContent: string }, PlannotatorPlanReviewStartResult>(
    pi,
    "plan-review",
    { planContent },
  );
  if (response?.status !== "handled") return null;
  if (response.result.status !== "pending" || !response.result.reviewId) return null;
  return { reviewId: response.result.reviewId };
}

/** Subscribe to plan-review verdicts emitted by Plannotator. */
export function onPlanReviewResult(
  pi: ExtensionAPI,
  handler: (event: PlannotatorReviewResultEvent) => void,
): void {
  pi.events.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, (data) => {
    const event = data as Partial<PlannotatorReviewResultEvent> | null;
    if (!event || typeof event.reviewId !== "string") return;
    handler(event as PlannotatorReviewResultEvent);
  });
}

/**
 * Recover the status of a previously started review (e.g. after a session
 * restart). Returns null when Plannotator is absent.
 */
export async function queryReviewStatus(
  pi: ExtensionAPI,
  reviewId: string,
): Promise<PlannotatorReviewStatusResult | null> {
  const response = await emitRequest<"review-status", { reviewId: string }, PlannotatorReviewStatusResult>(
    pi,
    "review-status",
    { reviewId },
  );
  if (response?.status !== "handled") return null;
  return response.result;
}
