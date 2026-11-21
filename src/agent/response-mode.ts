import { WEB_SEARCH_TOOL } from "./prompt.ts";
import type { ToolDefinition } from "../llm.ts";

export type ResponseMode = "standard" | "fast";

export const FAST_LIMITS = { searchRounds: 1, searches: 4, outputTokens: 1600, searchTimeoutMs: 10_000 } as const;

// Freshness and research allowances are selected by code. Content depth remains available for explicit source reads.
export const FAST_WEB_SEARCH_TOOL: ToolDefinition = { ...WEB_SEARCH_TOOL, function: { ...WEB_SEARCH_TOOL.function,
  parameters: { type: "object", required: ["query"], additionalProperties: false, properties: {
    query: { type: "string", description: "A focused search query naming the entity, facts and relevant dates." },
    content: { type: "string", enum: ["highlights", "full"], description: "Use full when the user requests full content, or a definition, table or qualification requires a deeper read from one or two known URLs. Full reads are bounded, query-focused excerpts, not a guarantee of complete document coverage. Otherwise use highlights." },
    urls: { type: "array", maxItems: 5, items: { type: "string" }, description: "Optional exact public HTTP(S) URLs to read. Omit this field for a search." },
  } } } };

export const FAST_INSTRUCTIONS = `The user selected Fast mode: give a concise answer using one focused research round.
Batch the essential independent lookups together, at most four. Prefer primary sources and read known
source URLs directly when available. When the user explicitly requests full content from a known URL,
set content to full on that first lookup; include the factual question in query. Full content requires
one or two URLs and still returns bounded evidence, so never assume exhaustive document coverage.
Aim for about 150 words; use a compact table if it improves clarity.
Preserve the requested scope, and explicitly identify any items the limited research could not establish.
Do not claim exhaustive research or unchanged current facts without applicable evidence. If research
returns no usable evidence, say which facts remain unknown. Citations, temporal perspective and
conversation boundaries still apply. Do not add a preamble about Fast mode.`;
