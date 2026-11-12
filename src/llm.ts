/**
 * The model, behind the two calls the agent needs: a streamed chat turn that
 * may request tool calls, and a one-shot JSON answer for the memory step.
 *
 * It speaks OpenAI-style Chat Completions because that is the one dialect
 * nearly every host accepts (OpenAI, Azure Foundry, Fireworks, Groq,
 * OpenRouter), so a reviewer can point it at whichever key they already have
 * by changing three env vars.
 */
import OpenAI from "openai";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** "none" forces a written answer; used on the last allowed round. */
  toolChoice: "auto" | "none";
  onText(delta: string): void;
  signal?: AbortSignal;
}

export interface Llm {
  stream(request: StreamRequest): Promise<{ text: string; toolCalls: ToolCall[] }>;
  json(request: { system: string; user: string; signal?: AbortSignal }): Promise<unknown>;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fastModel?: string;
  reasoningEffort?: string;
}

export function createLlm(config: LlmConfig): Llm {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl || undefined, maxRetries: 1 });
  // Only sent when configured: hosts that do not know the parameter reject it.
  const effort = config.reasoningEffort ? { reasoning_effort: config.reasoningEffort as "low" } : {};

  return {
    async stream({ messages, tools, toolChoice, onText, signal }) {
      const stream = await client.chat.completions.create(
        { model: config.model, messages, tools, tool_choice: toolChoice, stream: true, ...effort },
        { signal },
      );

      let text = "";
      // A tool call arrives in fragments, keyed by its position in the list.
      const calls: ToolCall[] = [];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const part of delta.tool_calls ?? []) {
          const call = (calls[part.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
        }
      }
      return { text, toolCalls: calls.filter(Boolean) };
    },

    async json({ system, user, signal }) {
      const completion = await client.chat.completions.create(
        {
          model: config.fastModel || config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          ...effort,
        },
        { signal },
      );
      return parseJson(completion.choices[0]?.message.content ?? "");
    },
  };
}

/** Tolerates a model that wraps its JSON in prose or a code fence. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("Model did not return JSON");
    return JSON.parse(text.slice(start, end + 1));
  }
}
