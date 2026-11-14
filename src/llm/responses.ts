import type OpenAI from "openai";
import type { Response, ResponseInput } from "openai/resources/responses/responses";
import { parseJson, type ChatMessage, type Llm, type LlmConfig, type LlmUsage, type ToolCall, type ModelOutputItem } from "../llm.ts";

export function responsesInput(messages: ChatMessage[]): ResponseInput {
  const input: ResponseInput = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
    } else if (message.role === "assistant") {
      if (message.responseOutput) {

        input.push(...message.responseOutput);
      } else {
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) {
          input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
      }
    } else input.push({ role: message.role, content: message.content });
  }
  return input;
}

export function createResponsesLlm(client: OpenAI, config: LlmConfig, onUsage?: (usage: LlmUsage) => void): Llm {
  const reasoning = config.reasoningEffort ? { effort: config.reasoningEffort as "low" } : undefined;
  const reportUsage = (response: Response) => {
    if (response.usage) onUsage?.({ model: response.model, inputTokens: response.usage.input_tokens,
      cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: response.usage.output_tokens, reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
    });
  };
  return {
    async stream({ messages, tools, toolChoice, onText, signal }) {
      const stream = await client.responses.create({
        model: config.model, input: responsesInput(messages), store: false,
        include: ["reasoning.encrypted_content"], reasoning, stream: true,
        tools: tools.map(tool => ({ type: "function" as const, ...tool.function, strict: false })),
        tool_choice: toolChoice, parallel_tool_calls: true,
      }, { signal });

      let text = "";
      let completed: Response | undefined;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
          text += event.delta;
          onText(event.delta);
        } else if (event.type === "response.completed") completed = event.response;
        else if (event.type === "response.failed" || event.type === "response.incomplete") {
          reportUsage(event.response);
          throw new Error(`Model response ${event.response.status}: ${event.response.error?.message ?? event.response.incomplete_details?.reason ?? "no completed answer"}`);
        } else if (event.type === "error") throw new Error(`Model stream error: ${event.message}`);
      }
      signal?.throwIfAborted();
      if (!completed || completed.status !== "completed") throw new Error("Model stream ended before completion.");
      reportUsage(completed);
      const output = completed.output.map((item): ModelOutputItem => {
        if (item.type === "message" || item.type === "reasoning" || item.type === "function_call") return item;
        throw new Error(`Model returned an unsupported output item: ${item.type}`);
      });
      const toolCalls: ToolCall[] = output.filter(item => item.type === "function_call").map(item => {
        if (item.status === "incomplete" || !item.call_id || !item.name) throw new Error("Model returned an incomplete tool call.");
        return { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } };
      });
      const finalText = outputText(output);
      if (finalText !== text) {

        if (!text && finalText) onText(finalText);
        else if (finalText !== text) throw new Error("Model text stream did not match its completed response.");
      }
      return { text: finalText, toolCalls, responseOutput: output };
    },

    async json({ system, user, signal }) {
      const response = await client.responses.create({
        model: config.fastModel || config.model,
        input: [{ role: "system", content: system }, { role: "user", content: user }],
        text: { format: { type: "json_object" } }, reasoning, store: false,
      }, { signal });
      reportUsage(response);
      if (response.status !== "completed") throw new Error(`Model JSON response ${response.status}: ${response.error?.message ?? response.incomplete_details?.reason ?? "no completed JSON"}`);
      return parseJson(outputText(response.output));
    },
  };
}

function outputText(items: Response["output"]): string {
  return items.flatMap(item => item.type === "message" ? item.content.map(part => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "") : []).join("");
}
