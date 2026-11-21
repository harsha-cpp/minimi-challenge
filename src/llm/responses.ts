import type OpenAI from "openai";
import type { Response, ResponseInput } from "openai/resources/responses/responses";
import { MODEL_LIMITS, ModelError, normalizeModelError, outputTokens, parseJson, usageFromError, usageReporter, validateToolCalls,
  type ChatMessage, type Llm, type LlmConfig, type LlmOptions, type ToolCall, type ModelOutputItem } from "../llm.ts";

export function responsesInput(messages: ChatMessage[]): ResponseInput {
  const input: ResponseInput = [];
  for (const message of messages) {
    if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
    else if (message.role === "assistant") {
      if (message.responseOutput) input.push(...message.responseOutput);
      else {
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else input.push({ role: message.role, content: message.content });
  }
  return input;
}

export function createResponsesLlm(client: OpenAI, config: LlmConfig, options: LlmOptions = {}): Llm {
  const reasoning = config.reasoningEffort ? { effort: config.reasoningEffort as "low" } : undefined;
  return {
    async stream(request) {
      const { messages, tools, toolChoice, onText, signal } = request;
      const report = usageReporter(config.model, request, options);
      let abortStream: (() => void) | undefined;
      try {
        signal?.throwIfAborted();
        const stream = await client.responses.create({
          model: config.model, input: responsesInput(messages), store: false,
          include: ["reasoning.encrypted_content"], reasoning, stream: true,
          tools: tools.map(tool => ({ type: "function" as const, ...tool.function, strict: false })),
          tool_choice: toolChoice, parallel_tool_calls: true,
          max_output_tokens: outputTokens(request.maxOutputTokens, config.maxOutputTokens),
        }, { signal });
        abortStream = () => stream.controller.abort();
        let text = "", refused = false, argumentChars = 0;
        const argumentSizes = new Map<number, number>();
        let completed: Response | undefined;
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            if (text.length + event.delta.length > MODEL_LIMITS.textChars) throw new ModelError("output_limit", "Model text exceeded the size limit.");
            text += event.delta;
            onText(event.delta);
          } else if (event.type === "response.refusal.delta") refused = true;
          else if (event.type === "response.function_call_arguments.delta") {
            if (!Number.isInteger(event.output_index) || event.output_index < 0 || event.output_index >= MODEL_LIMITS.toolCalls + 16) throw new ModelError("invalid_tool", "Model returned an invalid tool index.");
            const size = (argumentSizes.get(event.output_index) ?? 0) + event.delta.length;
            argumentSizes.set(event.output_index, size);
            argumentChars += event.delta.length;
            if (size > MODEL_LIMITS.toolArgumentChars || argumentChars > MODEL_LIMITS.totalToolArgumentChars || argumentSizes.size > MODEL_LIMITS.toolCalls) throw new ModelError("output_limit", "Model tool arguments exceeded the size limit.");
          } else if (event.type === "response.completed") {
            if (completed) throw new ModelError("invalid_output", "Model sent duplicate terminal completions.");
            completed = event.response;
            setUsage(report, event.response, config.model);
          } else if (event.type === "response.failed" || event.type === "response.incomplete") {
            setUsage(report, event.response, config.model);
            assertCompleted(event.response);
            throw new ModelError("provider_error", "Model provider returned a failed response.");
          } else if (event.type === "error") throw new ModelError("provider_error", "Model provider stream failed.");
        }
        signal?.throwIfAborted();
        if (!completed) throw new ModelError("interrupted", "Model stream ended before completion.");
        assertCompleted(completed);
        if (refused) throw new ModelError("refused", "Model declined to answer this request.");
        const output = validateOutput(completed.output);
        const toolCalls: ToolCall[] = output.filter(item => item.type === "function_call").map(item => {
          if (item.status === "incomplete" || item.status === "in_progress") throw new ModelError("invalid_tool", "Model returned an incomplete tool call.");
          return { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } };
        });
        validateToolCalls(toolCalls, tools, toolChoice);
        const finalText = outputText(output);
        if (!toolCalls.length && !finalText.trim()) throw new ModelError("invalid_output", "Model returned an empty answer.");
        if (finalText !== text) {
          if (!text && finalText) onText(finalText);
          else throw new ModelError("interrupted", "Model text stream did not match its completed response.");
        }
        report.finish("completed");
        return { text: finalText, toolCalls, responseOutput: output, completion: "completed", usage: report.usage };
      } catch (error) {
        abortStream?.();
        const supplied = usageFromError(error, config.model);
        if (supplied) report.set(supplied);
        const failure = normalizeModelError(error, signal);
        report.finish(failure.code);
        throw failure;
      }
    },
    async json(request) {
      const { system, user, signal } = request;
      const model = config.fastModel || config.model;
      const report = usageReporter(model, request, options);
      try {
        signal?.throwIfAborted();
        const response = await client.responses.create({
          model, input: [{ role: "system", content: system }, { role: "user", content: user }],
          text: { format: { type: "json_object" } }, reasoning, store: false,
          max_output_tokens: outputTokens(request.maxOutputTokens, config.maxJsonOutputTokens, true),
        }, { signal });
        setUsage(report, response, model);
        signal?.throwIfAborted();
        assertCompleted(response);
        const output = validateOutput(response.output);
        if (output.some(item => item.type === "function_call")) throw new ModelError("invalid_tool", "Model JSON contained unexpected tool calls.");
        const result = parseJson(outputText(output));
        report.finish("completed");
        return result;
      } catch (error) {
        const supplied = usageFromError(error, model);
        if (supplied) report.set(supplied);
        const failure = normalizeModelError(error, signal);
        report.finish(failure.code);
        throw failure;
      }
    },
  };
}
function setUsage(report: ReturnType<typeof usageReporter>, response: Response, fallback: string): void {
  if (response.usage) report.set({ model: response.model || fallback, inputTokens: response.usage.input_tokens,
    cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: response.usage.output_tokens, reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0 });
}
function assertCompleted(response: Response): void {
  if (response.status === "completed") return;
  const reason = response.incomplete_details?.reason;
  if (reason === "max_output_tokens") throw new ModelError("truncated", "Model response incomplete: max_output_tokens.");
  if (reason === "content_filter") throw new ModelError("filtered", "Model response incomplete: content_filter.");
  throw new ModelError(response.status === "failed" ? "provider_error" : "interrupted", "Model response did not complete.");
}
function validateOutput(items: Response["output"]): ModelOutputItem[] {
  if (items.length > 64 || JSON.stringify(items).length > MODEL_LIMITS.responseChars) throw new ModelError("output_limit", "Model response exceeded the size limit.");
  return items.map(item => {
    if (item.type === "message") {
      if (item.status !== "completed") throw new ModelError("interrupted", "Model returned an incomplete message.");
      if (item.content.some(part => part.type === "refusal")) throw new ModelError("refused", "Model declined to answer this request.");
    }
    if (item.type === "message" || item.type === "reasoning" || item.type === "function_call") return item;
    throw new ModelError("invalid_output", "Model returned an unsupported output item.");
  });
}
function outputText(items: Response["output"]): string {
  const result = items.flatMap(item => item.type === "message" ? item.content.map(part => part.type === "output_text" ? part.text : "") : []).join("");
  if (result.length > MODEL_LIMITS.textChars) throw new ModelError("output_limit", "Model text exceeded the size limit.");
  return result;
}
