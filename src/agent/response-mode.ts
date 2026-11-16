import { WEB_SEARCH_TOOL } from "./prompt.ts";
import type { ToolDefinition } from "../llm.ts";

export type ResponseMode = "standard" | "fast";

export const FAST_LIMITS = { searchRounds: 1, searches: 4, outputTokens: 1600, searchTimeoutMs: 10_000 } as const;

// Freshness and depth are selected by code. A smaller tool schema leaves less room for invalid options.
export const FAST_WEB_SEARCH_TOOL: ToolDefinition = { ...WEB_SEARCH_TOOL, function: { ...WEB_SEARCH_TOOL.function,
  parameters: { type: "object", required: ["query"], additionalProperties: false, properties: {
    query: { type: "string", description: "A focused search query naming the entity, facts and relevant dates." },
    urls: { type: "array", maxItems: 5, items: { type: "string" }, description: "Optional exact public HTTP(S) URLs to read. Omit this field for a search." },
  } } } };

export const FAST_INSTRUCTIONS = `The user selected Fast mode: give a concise answer using one focused research round.
Batch the essential independent lookups together, at most four. Prefer primary sources and read known
source URLs directly when available. Aim for about 150 words; use a compact table if it improves clarity.
Preserve the requested scope, and explicitly identify any items the limited research could not establish.
Do not claim exhaustive research or unchanged current facts without applicable evidence. If research
returns no usable evidence, say which facts remain unknown. Citations, temporal perspective and
conversation boundaries still apply. Do not add a preamble about Fast mode.`;
