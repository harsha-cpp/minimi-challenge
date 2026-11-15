import OpenAI from "openai";
import { AsyncLocalStorage } from "node:async_hooks";
import { AdmissionError, currentModelContext } from "./llm/gateway.ts";
import { SpendBudgetError } from "./runtime/spend-store.ts";
import { defaultProviderSpending, envelopeFor, ProviderBudgetError, reportedModelDollars, reservedModelDollars, type ProviderSpendingPolicy } from "./runtime/provider-spending.ts";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { createResponsesLlm } from "./llm/responses.ts";

export type ModelOutputItem = Extract<ResponseOutputItem, { type: "message" | "function_call" | "reasoning" }>;
export type ModelPurpose = "research" | "synthesis" | "review" | "repair" | "enrichment";
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; responseOutput?: ModelOutputItem[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string }; }
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ModelRequestOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  purpose?: ModelPurpose;
  /** Called exactly once, including failures. null means the provider did not report usage. */
  onUsage?: (usage: LlmUsage | null) => void;
}
export interface StreamRequest extends ModelRequestOptions {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolChoice: "auto" | "none";
  onText(delta: string): void;
}
export interface JsonRequest extends ModelRequestOptions { system: string; user: string; }
export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  responseOutput?: ModelOutputItem[];
  completion?: "completed";
  usage?: LlmUsage | null;
}
export interface Llm {
  stream(request: StreamRequest): Promise<StreamResult>;
  json(request: JsonRequest): Promise<unknown>;
}
export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fastModel?: string;
  reasoningEffort?: string;
  apiMode?: "chat_completions" | "responses";
  /** Explicit capability overrides for compatible Chat Completions hosts. */
  tokenLimitParameter?: "max_completion_tokens" | "max_tokens";
  supportsStreamUsage?: boolean;
  maxOutputTokens?: number;
  maxJsonOutputTokens?: number;
}
export interface LlmUsage {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}
export type ModelErrorCode = "interrupted" | "truncated" | "filtered" | "refused" | "provider_error" | "invalid_output" | "invalid_tool" | "output_limit";
export class ModelError extends Error {
  constructor(readonly code: ModelErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "ModelError"; }
}
export const MODEL_LIMITS = {
  outputTokens: 4096, jsonOutputTokens: 2048, textChars: 32_000, toolArgumentChars: 16_000,
  totalToolArgumentChars: 48_000, toolCalls: 16, responseChars: 256_000, responseBytes: 4_000_000,
} as const;
export interface LlmOptions {
  /** null is permitted only with an injected test transport. */
  spendPolicy?: ProviderSpendingPolicy | null;
  fetch?: typeof fetch;
  onUsage?: (usage: LlmUsage) => void;
  onUsageStatus?: (record: { model: string; usage: LlmUsage | null; outcome: "completed" | ModelErrorCode }) => void;
}
export function outputTokens(requested: number | undefined, configured: number | undefined, json = false): number {
  const cap = configured ?? (json ? MODEL_LIMITS.jsonOutputTokens : MODEL_LIMITS.outputTokens);
  if (!Number.isInteger(cap) || cap < 1 || cap > 32_768) throw new ModelError("output_limit", "Invalid model output-token limit.");
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) throw new ModelError("output_limit", "Invalid model output-token limit.");
  return Math.min(requested ?? cap, cap);
}
export function validateToolCalls(calls: ToolCall[], tools: ToolDefinition[], toolChoice: "auto" | "none"): void {
  if (calls.length > MODEL_LIMITS.toolCalls || (toolChoice === "none" && calls.length)) throw new ModelError("invalid_tool", "Model returned unexpected tool calls.");
  const ids = new Set<string>();
  let total = 0;
  for (const call of calls) {
    if (!call || !call.function || !/^[a-zA-Z0-9_-]{1,200}$/.test(call.id) || ids.has(call.id)
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.function.name)
      || !tools.some(tool => tool.function.name === call.function.name)) throw new ModelError("invalid_tool", "Model returned an invalid tool call.");
    ids.add(call.id);
    total += call.function.arguments.length;
    if (call.function.arguments.length > MODEL_LIMITS.toolArgumentChars || total > MODEL_LIMITS.totalToolArgumentChars) throw new ModelError("output_limit", "Model tool arguments exceeded the size limit.");
    try {
      const args: unknown = JSON.parse(call.function.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
    } catch { throw new ModelError("invalid_tool", "Model returned incomplete or malformed tool arguments."); }
  }
}
export function normalizeModelError(error: unknown, signal?: AbortSignal): ModelError {
  if (error instanceof ModelError) return error;
  if (error && typeof error === "object" && "cause" in error && error.cause instanceof ModelError) return error.cause;
  if (signal?.aborted) return new ModelError("interrupted", "Model request was interrupted.", { cause: error });
  return new ModelError("provider_error", "Model provider request failed.", { cause: error });
}
export function usageReporter(model: string, request: ModelRequestOptions, options: LlmOptions) {
  let usage: LlmUsage | null = null;
  let sent = false;
  return {
    set(value: LlmUsage) { usage = value; },
    get usage() { return usage; },
    finish(outcome: "completed" | ModelErrorCode) {
      if (sent) return;
      sent = true;
      if (usage) options.onUsage?.(usage);
      request.onUsage?.(usage);
      options.onUsageStatus?.({ model, usage, outcome });
    },
  };
}
function chatFinish(reason: string | null | undefined): void {
  if (reason === "stop" || reason === "tool_calls") return;
  if (reason === "length") throw new ModelError("truncated", "Model response was truncated (length).");
  if (reason === "content_filter") throw new ModelError("filtered", "Model response was filtered.");
  throw new ModelError("interrupted", "Model stream ended before completion.");
}
export function chatUsage(model: string, usage: OpenAI.Completions.CompletionUsage): LlmUsage {
  return { model, inputTokens: usage.prompt_tokens, cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.completion_tokens, reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 };
}

export function usageFromError(error: unknown, fallbackModel: string): LlmUsage | null {
  if (!error || typeof error !== "object") return null;
  const data = "error" in error && error.error && typeof error.error === "object" ? error.error as Record<string, unknown> : error as Record<string, unknown>;
  const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : undefined;
  if (!usage) return null;
  const model = typeof data.model === "string" ? data.model : fallbackModel;
  const input = usage.input_tokens ?? usage.prompt_tokens, output = usage.output_tokens ?? usage.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isInteger(input) || !Number.isInteger(output) || input < 0 || output < 0) return null;
  return { model, inputTokens: input, outputTokens: output, cachedInputTokens: 0, reasoningTokens: 0 };
}

const opaqueInputBounds = new WeakMap<ModelOutputItem, number>();
interface RequestCharge {
  hold?: ReturnType<ProviderSpendingPolicy["store"]["reserve"]>;
  started: boolean;
}
export function createLlm(config: LlmConfig, options: LlmOptions = {}): Llm {
  if (options.spendPolicy === null && !options.fetch) throw new Error("Disabling provider accounting requires an injected test transport.");
  const policy = options.spendPolicy === null ? null : options.spendPolicy ?? defaultProviderSpending();
  const chargeContext = new AsyncLocalStorage<RequestCharge>();
  const http = options.fetch ?? fetch;
  // A stream can carry arbitrarily large terminal items, even when individual deltas are small.
  const boundedFetch: typeof fetch = async (...args) => {
    args[1]?.signal?.throwIfAborted();
    const charge = chargeContext.getStore();
    if (charge && !charge.started) { charge.hold?.markStarted(); charge.started = true; }
    const response = await http(...args);
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MODEL_LIMITS.responseBytes) throw new ModelError("output_limit", "Model response exceeded the transport size limit.");
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  // Retry is owned by the application budget; an SDK retry must not spend an unrecorded request.
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl || undefined, maxRetries: 0, fetch: boundedFetch });
  if (config.apiMode === "responses") return guardedProviderLlm(createResponsesLlm(client, config, options), config, policy, chargeContext);
  const effort = config.reasoningEffort ? { reasoning_effort: config.reasoningEffort as "low" } : {};
  const limit = (value: number) => config.tokenLimitParameter === "max_tokens" ? { max_tokens: value } : { max_completion_tokens: value };
  const adapter: Llm = {
    async stream(request) {
      const { messages, tools, toolChoice, onText, signal } = request;
      const report = usageReporter(config.model, request, options);
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>> | undefined;
      try {
        signal?.throwIfAborted();
        const source = await client.chat.completions.create({ model: config.model, messages, tools, tool_choice: toolChoice, stream: true,
          ...(config.supportsStreamUsage === false ? {} : { stream_options: { include_usage: true } }),
          ...limit(outputTokens(request.maxOutputTokens, config.maxOutputTokens)), ...effort }, { signal });
        stream = source;
        let text = "", finish: string | null | undefined, refused = false, argumentChars = 0;
        const calls: ToolCall[] = [];
        for await (const chunk of source) {
          if (chunk.usage) report.set(chatUsage(chunk.model || config.model, chunk.usage));
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (finish !== undefined && (choice.delta.content || choice.delta.refusal || choice.delta.tool_calls?.length || choice.finish_reason)) throw new ModelError("invalid_output", "Model sent output after its terminal completion.");
          if (choice.finish_reason) finish = choice.finish_reason;
          const delta = choice.delta;
          if (delta.refusal) refused = true;
          if (delta.content) {
            if (text.length + delta.content.length > MODEL_LIMITS.textChars) throw new ModelError("output_limit", "Model text exceeded the size limit.");
            text += delta.content;
            onText(delta.content);
          }
          for (const part of delta.tool_calls ?? []) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index >= MODEL_LIMITS.toolCalls) throw new ModelError("invalid_tool", "Model returned an invalid tool index.");
            const call = (calls[part.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
            if (part.id) {
              if (part.id.length > 200 || (call.id && part.id !== call.id)) throw new ModelError("invalid_tool", "Model returned an invalid tool identity.");
              call.id = part.id;
            }
            if (part.function?.name) {
              call.function.name += part.function.name;
              if (call.function.name.length > 128) throw new ModelError("invalid_tool", "Model returned an invalid tool name.");
            }
            if (part.function?.arguments) {
              argumentChars += part.function.arguments.length;
              call.function.arguments += part.function.arguments;
              if (call.function.arguments.length > MODEL_LIMITS.toolArgumentChars || argumentChars > MODEL_LIMITS.totalToolArgumentChars) throw new ModelError("output_limit", "Model tool arguments exceeded the size limit.");
            }
          }
        }
        signal?.throwIfAborted();
        chatFinish(finish);
        if (refused) throw new ModelError("refused", "Model declined to answer this request.");
        if (Array.from(calls).some(call => !call)) throw new ModelError("invalid_tool", "Model returned incomplete tool calls.");
        validateToolCalls(calls, tools, toolChoice);
        if (!calls.length && !text.trim()) throw new ModelError("invalid_output", "Model returned an empty answer.");
        if ((finish === "tool_calls") !== Boolean(calls.length)) throw new ModelError("invalid_tool", "Model tool completion did not match its output.");
        report.finish("completed");
        return { text, toolCalls: calls, completion: "completed", usage: report.usage };
      } catch (error) {
        // The SDK stream owns an AbortController; aborting also closes an oversized upstream body.
        if (stream && "controller" in stream) (stream.controller as AbortController).abort();
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
        const completion = await client.chat.completions.create({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: { type: "json_object" }, ...limit(outputTokens(request.maxOutputTokens, config.maxJsonOutputTokens, true)), ...effort }, { signal });
        if (completion.usage) report.set(chatUsage(completion.model || model, completion.usage));
        signal?.throwIfAborted();
        const choice = completion.choices[0];
        chatFinish(choice?.finish_reason);
        if (choice?.message.refusal) throw new ModelError("refused", "Model declined to answer this request.");
        const content = choice?.message.content ?? "";
        if (content.length > MODEL_LIMITS.textChars) throw new ModelError("output_limit", "Model JSON exceeded the size limit.");
        if (choice?.message.tool_calls?.length) throw new ModelError("invalid_tool", "Model JSON contained unexpected tool calls.");
        const result = parseJson(content);
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
  return guardedProviderLlm(adapter, config, policy, chargeContext);
}
function guardedProviderLlm(adapter: Llm, config: LlmConfig, policy: ProviderSpendingPolicy | null, context: AsyncLocalStorage<RequestCharge>): Llm {
  async function run<T>(kind: "stream" | "json", request: StreamRequest | JsonRequest, operation: (request: StreamRequest | JsonRequest) => Promise<T>): Promise<T> {
    const charge: RequestCharge = { started: false };
    let usage: LlmUsage | null = null;
    try {
      request.signal?.throwIfAborted();
      const model = kind === "json" ? config.fastModel || config.model : config.model;
      const rates = policy ? envelopeFor(policy, model) : undefined;
      const cap = outputTokens(request.maxOutputTokens, kind === "json" ? config.maxJsonOutputTokens : config.maxOutputTokens, kind === "json");
      const payload = kind === "json" ? [(request as JsonRequest).system, (request as JsonRequest).user] : [(request as StreamRequest).messages, (request as StreamRequest).tools];
      // UTF-8 bytes conservatively bound text tokens; allow additional protocol/control tokens.
      let opaqueCeiling = 0;
      if (policy && kind === "stream") for (const message of (request as StreamRequest).messages) {
        if (message.role !== "assistant") continue;
        for (const item of message.responseOutput ?? []) if (item.type === "reasoning" && item.encrypted_content) {
          const ceiling = opaqueInputBounds.get(item);
          if (ceiling === undefined) throw new ProviderBudgetError("Opaque model history without a recorded token bound cannot use the paid allowance.");
          opaqueCeiling += ceiling;
        }
      }
      const inputCeiling = Buffer.byteLength(JSON.stringify(payload)) + opaqueCeiling + 2048 + (kind === "stream" ? (request as StreamRequest).messages.length * 32 : 64);
      const active = currentModelContext();
      if (policy && rates) charge.hold = policy.store.reserve({ provider: "azure", maxDollars: reservedModelDollars(rates, inputCeiling, cap),
        stage: request.purpose ?? kind, model, turnId: active?.turnId, ownerId: active?.ownerId, policyVersion: policy.priceVersion });
      try {
        const result = await context.run(charge, () => operation({ ...request, maxOutputTokens: cap, onUsage: value => { usage = value; request.onUsage?.(value); } }));
        if (policy && kind === "stream") for (const item of (result as StreamResult).responseOutput ?? []) if (item.type === "reasoning" && item.encrypted_content) opaqueInputBounds.set(item, cap);
        return result;
      } finally {
        if (charge.hold) {
          if (charge.started) charge.hold.settle(rates ? reportedModelDollars(rates, usage) : null);
          else charge.hold.cancelBeforeStart();
        }
      }
    } catch (error) {
      let cause: unknown = error, budgetFailure = false;
      for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
        if (cause instanceof SpendBudgetError || cause instanceof ProviderBudgetError) { budgetFailure = true; break; }
        cause = "cause" in cause ? cause.cause : undefined;
      }
      const failure = budgetFailure ? new AdmissionError("budget", charge.started
        ? "The Azure allowance could not safely account for this attempt. Further paid work is stopped."
        : "The total Azure allowance or its verified price envelope is unavailable. No model request was sent.") : error;
      if (failure && typeof failure === "object") Object.defineProperty(failure, "providerStarted", { value: charge.started, configurable: true });
      throw failure;
    }
  }
  return { stream: request => run("stream", request, value => adapter.stream(value as StreamRequest)),
    json: request => run("json", request, value => adapter.json(value as JsonRequest)) };
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch {
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new ModelError("invalid_output", "Model did not return JSON.");
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch { throw new ModelError("invalid_output", "Model did not return valid JSON."); }
  }
}
