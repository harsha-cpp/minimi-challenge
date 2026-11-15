// Recovery is read-only. A missing completion never triggers another generation.
export async function readTurn(turnId, request = fetch, signal) {
  const path = typeof turnId === "string" ? `/api/turns/${encodeURIComponent(turnId)}`
    : `/api/turns/by-key/${encodeURIComponent(turnId.idempotencyKey)}`;
  const response = await request(path, { signal });
  if (response.status === 404) return { turn: null };
  if (!response.ok) throw new Error("The saved answer status could not be loaded. Check again before retrying.");
  const result = await response.json();
  if (!result.turn || !["running", "completed", "failed", "interrupted"].includes(result.turn.status)) throw new Error("The saved answer status is invalid.");
  if (result.turn.status === "completed" && (!result.episode || typeof result.episode.answer !== "string")) throw new Error("The saved answer could not be recovered.");
  return result;
}
