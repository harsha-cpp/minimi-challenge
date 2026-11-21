/** Aggregate retained operational traces only. No prompts, identities or source URLs are returned. */
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]! : null;
function distribution(values: number[]) {
  return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: values.length >= 20 ? percentile(values, 0.95) : null,
    maxMs: values.length ? Math.max(...values) : null };
}
export function outcomeCategory(outcome: unknown): string {
  if (["completed", "cancelled", "interrupted", "running"].includes(String(outcome))) return String(outcome);
  if (outcome === "waiting_input" || outcome === "clarification_required") return "waiting_input";
  if (outcome === "deadline" || outcome === "admission_deadline" || outcome === "turn_timeout") return "deadline";
  if (String(outcome).startsWith("admission_") || outcome === "budget") return "rejected";
  if (outcome === "provider_error" || outcome === "provider_failure" || outcome === "model_provider_error") return "provider_failure";
  return "failed";
}
export function summarizeTraces(input: Array<Record<string, unknown>>) {
  const rows = input.slice(0, 1000).map(trace => {
    const stages = Array.isArray(trace.stages) ? trace.stages.map(object) : [];
    const mode = object(stages.find(s => s.name === "response_mode")?.data).mode;
    const intent = object(stages.find(s => s.name === "request_policy")?.data).intent;
    return { outcome: outcomeCategory(trace.outcome), mode: mode === "fast" ? "fast" : mode === "standard" ? "standard" : "unknown",
      intent: ["conversation", "recall", "creative", "transform", "verify", "lookup"].includes(String(intent)) ? String(intent) : "unknown",
      quality: ["supported", "supported_partial", "explicitly_unverified", "non_factual"].includes(String(trace.quality)) ? String(trace.quality) : "unknown",
      total: trace.totalMs, firstText: trace.serverFirstEmissionMs, firstRender: trace.clientFirstRenderMs };
  });
  const aggregate = (selected: typeof rows) => {
    const completed = selected.filter(row => row.outcome === "completed");
    return { attempts: selected.length, outcomes: Object.fromEntries([...new Set(selected.map(row => row.outcome))].sort().map(key => [key, selected.filter(row => row.outcome === key).length])),
      completedQuality: Object.fromEntries([...new Set(completed.map(row => row.quality))].sort().map(key => [key, completed.filter(row => row.quality === key).length])),
      completedMs: distribution(completed.map(row => row.total).filter(finite)),
      firstAnswerTextMs: distribution(completed.map(row => row.firstText).filter(finite)),
      firstBrowserRenderMs: distribution(completed.map(row => row.firstRender).filter(finite)),
      failedMs: distribution(selected.filter(row => !["completed", "waiting_input", "running"].includes(row.outcome)).map(row => row.total).filter(finite)) };
  };
  const groups = [...new Set(rows.map(row => `${row.mode}/${row.intent}`))].sort();
  return { scope: "At most 1000 retained turns. Includes unsuccessful attempts. Not visitors or a representative benchmark. p95 requires 20 measured samples per metric.",
    overall: aggregate(rows), byModeAndIntent: Object.fromEntries(groups.map(key => [key, aggregate(rows.filter(row => `${row.mode}/${row.intent}` === key))])) };
}
