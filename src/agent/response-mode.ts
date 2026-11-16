export type ResponseMode = "standard" | "fast";

export const FAST_LIMITS = { searchRounds: 1, searches: 4, outputTokens: 1600, searchTimeoutMs: 10_000 } as const;

export const FAST_INSTRUCTIONS = `The user selected Fast mode: give a concise answer using one focused research round.
Batch the essential independent lookups together, at most four. Prefer primary sources and read known
source URLs directly when available. Aim for about 150 words; use a compact table if it improves clarity.
Preserve the requested scope, and explicitly identify any items the limited research could not establish.
Do not claim exhaustive research or unchanged current facts without applicable evidence. If research
returns no usable evidence, say which facts remain unknown. Citations, temporal perspective and
conversation boundaries still apply. Do not add a preamble about Fast mode.`;
