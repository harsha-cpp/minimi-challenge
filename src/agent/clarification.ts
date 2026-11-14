import type { ToolDefinition } from "../llm.ts";
import type { TurnTime } from "../clock.ts";
import { turnPolicy } from "./prepare.ts";

export interface ClarificationQuestion {
  question: string;
  why: string;
  options: Array<{ id: string; label: string; detail: string }>;
}
export interface ClarificationCard extends ClarificationQuestion {
  id: string;
  message: string;
  time: TurnTime;
  selection?: ClarificationAnswer;
}
export type ClarificationSelection = { optionId: string } | { text: string } | { skip: true };
export interface ClarificationAnswer {
  id: string;
  question: string;
  answer: string;
  skipped: boolean;
  optionId?: string;
}
export interface ClarificationPort {
  create(input: { sessionId: string; message: string; time: TurnTime; question: ClarificationQuestion }): ClarificationCard;
}

/** An opportunity to ask, never a random quota or a mandatory planner request. */
export function canClarify(message: string, simulated: boolean): boolean {
  const policy = turnPolicy(message, simulated);
  if (!["lookup", "verify"].includes(policy.intent)) return false;
  if (/\b(?:don'?t|do not|without|no)\s+(?:ask(?:ing)?\s+(?:me\s+)?(?:any\s+)?(?:follow[- ]?up\s+)?questions|questions|clarification)\b|\b(?:just answer|use your (?:best )?judg(?:e)?ment|make (?:reasonable |your own )?assumptions)\b/i.test(message)) return false;
  return /\b(?:recommend(?:ations?)?|suggest(?:ions?)?|find|choose|choosing|best|compare|comparison|versus|vs|help|plan|planning|strategy|analy[sz]e|analysis|research|explain|understand|learn|improve|design|build|evaluate|assess|which|options|overview)\b|\b(?:tell me about|looking for|what should|what can|how (?:can|should|do|to))\b/i.test(message);
}

export const CLARIFICATION_INSTRUCTIONS = `You may use ask_clarification ONCE, before web research, when a missing user preference or scope would materially change the answer. This is optional: a rough preference is to clarify about half of genuinely open-ended research/recommendation tasks, not half of all messages. Never ask randomly or meet a numeric quota.
Ask one concise, high-value question with 2–4 distinct choices. Good dimensions: use case, budget, geography, intended audience, comparison criteria, or scope. Explain briefly why this changes the research. Options describe user preferences, not factual assertions. Do not create an "Other" or "Skip" option: the interface provides free text and skip automatically. Do not preselect an option.
Use prior conversation and provided preferences; do not ask for information already supplied. Clear factual questions, greetings, simple transformations and specified tasks should receive a direct answer. Do not ask after the user requests no questions. Do not ask merely to choose answer length or to test the user's knowledge. Never call ask_clarification together with web_search: ask first if necessary, otherwise research and answer normally.
Respect the selected era even in the question/options. Do not reveal later events or present future technologies as available. For a question with a false historical premise, research and correct it directly instead of asking a preference question. Await a REAL user selection; never answer the question for the user or simulate their click. The app will resume the original request using the selected detail.`;

export const ASK_CLARIFICATION_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "ask_clarification",
    description: "Ask one optional multiple-choice preference/scope question before researching an underspecified request. Ends this response and waits for the user's actual choice.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["question", "why", "options"],
      properties: {
        question: { type: "string", maxLength: 180 },
        why: { type: "string", maxLength: 240 },
        options: { type: "array", minItems: 2, maxItems: 4, items: {
          type: "object", additionalProperties: false, required: ["label", "detail"],
          properties: { label: { type: "string", maxLength: 80 }, detail: { type: "string", maxLength: 160 } },
        } },
      },
    },
  },
};

export function parseClarification(argumentsJson: string): ClarificationQuestion | null {
  if (argumentsJson.length > 4000) return null;
  try {
    const raw = JSON.parse(argumentsJson);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["question", "why", "options"].includes(k))) return null;
    const question = clean(raw.question, 180), why = clean(raw.why, 240);
    if (!question || !why || !Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) return null;
    const seen = new Set<string>();
    const options: ClarificationQuestion["options"] = [];
    for (const [i, option] of raw.options.entries()) {
      if (!option || typeof option !== "object" || Array.isArray(option) || Object.keys(option).some(k => !["label", "detail"].includes(k))) return null;
      const label = clean(option.label, 80), detail = clean(option.detail, 160);
      if (!label || !detail || /^(?:other|skip|none of the above)\b/i.test(label) || seen.has(label.toLocaleLowerCase())) return null;
      seen.add(label.toLocaleLowerCase()); options.push({ id: String.fromCharCode(97 + i), label, detail });
    }
    return { question, why, options };
  } catch { return null; }
}

export function parseSelection(raw: unknown): ClarificationSelection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 1) return null;
  if (value.skip === true) return { skip: true };
  if (typeof value.optionId === "string" && /^[a-d]$/.test(value.optionId)) return { optionId: value.optionId };
  const text = clean(value.text, 1000);
  return text ? { text } : null;
}
function clean(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return null;
  return value.replace(/\s+/g, " ").trim() || null;
}
