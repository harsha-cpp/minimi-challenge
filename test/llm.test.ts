import assert from "node:assert/strict";
import { test } from "node:test";
import { createLlm, type ChatMessage, type LlmConfig, type ModelOutputItem } from "../src/llm.ts";
import { responsesInput } from "../src/llm/responses.ts";
import { WEB_SEARCH_TOOL } from "../src/agent/prompt.ts";

const config: LlmConfig = { apiKey: "test-key", baseUrl: "https://example.com/openai/v1/", model: "sol-deployment", fastModel: "luna-deployment", apiMode: "responses", reasoningEffort: "low" };
const message = (text: string, id = "msg-1") => ({ type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const completed = (output: unknown[], status = "completed") => ({ id: "resp-1", object: "response", status, output });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const terminal = (output: unknown[], text?: string) => sse([
  ...(text ? [{ type: "response.output_text.delta", delta: text }] : []),
  { type: "response.completed", response: completed(output) },
]);
const basic = { messages: [{ role: "user", content: "question" }] as ChatMessage[], tools: [WEB_SEARCH_TOOL], toolChoice: "auto" as const, onText: (_text: string) => {} };

function mockHttp(responses: Response[]) {
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const http = (async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    assert.ok(responses.length, "Unexpected model HTTP request");
    return responses.shift()!;
  }) as typeof fetch;
  return { http, requests };
}

test("Responses streams text and sends the Azure deployment with stateless tool configuration", async () => {
  const { http, requests } = mockHttp([terminal([message("An answer.")], "An answer.")]);
  const deltas: string[] = [];
  const answer = await createLlm(config, { fetch: http }).stream({ ...basic, onText: text => deltas.push(text) });
  assert.equal(requests[0]!.url, "https://example.com/openai/v1/responses");
  assert.equal(requests[0]!.body.model, "sol-deployment");
  assert.equal(requests[0]!.body.store, false);
  assert.deepEqual(requests[0]!.body.reasoning, { effort: "low" });
  assert.deepEqual(requests[0]!.body.include, ["reasoning.encrypted_content"]);
  assert.equal(requests[0]!.body.tools[0].name, "web_search");
  assert.equal(requests[0]!.body.tools[0].strict, false);
  assert.equal(requests[0]!.body.tools[0].function, undefined);
  assert.equal(requests[0]!.body.previous_response_id, undefined);
  assert.deepEqual(deltas, ["An answer."]);
  assert.equal(answer.text, "An answer.");
});

test("parallel tool calls use call_id and preserve completed reasoning/output items in order", async () => {
  const reasoning = { type: "reasoning", id: "rs-1", encrypted_content: "opaque-final", summary: [] };
  const call = { type: "function_call", id: "fc-1", call_id: "call-1", name: "web_search", arguments: '{"query":"one"}', status: "completed" };
  const call2 = { ...call, id: "fc-2", call_id: "call-2", arguments: '{"query":"two"}' };
  const output = [reasoning, call, call2];
  const { http, requests } = mockHttp([
    sse([
      { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: "partial" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"query":' },
      { type: "response.completed", response: completed(output) },
    ]), terminal([message("Done.")], "Done."),
  ]);
  const llm = createLlm(config, { fetch: http });
  const first = await llm.stream(basic);
  assert.deepEqual(first.toolCalls.map(c => c.id), ["call-1", "call-2"]);
  assert.equal(first.toolCalls[0]!.function.arguments, '{"query":"one"}');
  await llm.stream({ ...basic, toolChoice: "none", messages: [...basic.messages,
    { role: "assistant", content: null, tool_calls: first.toolCalls, responseOutput: first.responseOutput },
    { role: "tool", tool_call_id: "call-1", content: "source one" },
    { role: "tool", tool_call_id: "call-2", content: "source two" },
  ] });
  assert.deepEqual(requests[1]!.body.input, [
    { role: "user", content: "question" }, ...output,
    { type: "function_call_output", call_id: "call-1", output: "source one" },
    { type: "function_call_output", call_id: "call-2", output: "source two" },
  ]);
  assert.equal(requests[1]!.body.tool_choice, "none");
});

test("interleaved requests never share opaque reasoning or response IDs", async () => {
  const own = (id: string) => ({ type: "reasoning", id, encrypted_content: `opaque-${id}`, summary: [] });
  const { http, requests } = mockHttp([terminal([own("A"), message("A")], "A"), terminal([own("B"), message("B")], "B"), terminal([message("A continued")], "A continued")]);
  const llm = createLlm(config, { fetch: http });
  const [a] = await Promise.all([llm.stream({ ...basic, messages: [{ role: "user", content: "A" }] }), llm.stream({ ...basic, messages: [{ role: "user", content: "B" }] })]);
  await llm.stream({ ...basic, messages: [{ role: "user", content: "A" }, { role: "assistant", content: a.text, responseOutput: a.responseOutput }, { role: "user", content: "continue" }] });
  assert.ok(JSON.stringify(requests[2]!.body.input).includes("opaque-A"));
  assert.ok(!JSON.stringify(requests[2]!.body.input).includes("opaque-B"));
});

test("Responses JSON extraction uses the fast deployment and rejects incomplete JSON responses", async () => {
  const json = { summary: "s", topics: [], claims: [] };
  const { http, requests } = mockHttp([
    Response.json(completed([message(JSON.stringify(json))])),
    Response.json({ ...completed([message('{"summary":')], "incomplete"), incomplete_details: { reason: "max_output_tokens" } }),
  ]);
  const llm = createLlm(config, { fetch: http });
  assert.deepEqual(await llm.json({ system: "Return JSON.", user: "extract" }), json);
  assert.equal(requests[0]!.body.model, "luna-deployment");
  assert.deepEqual(requests[0]!.body.text, { format: { type: "json_object" } });
  assert.equal(requests[0]!.body.store, false);
  await assert.rejects(llm.json({ system: "Return JSON.", user: "extract" }), /incomplete.*max_output_tokens/);
});

test("failed, incomplete and truncated streams cannot produce executable tool calls", async () => {
  for (const events of [
    [{ type: "response.failed", response: { ...completed([], "failed"), error: { message: "service failed" } } }],
    [{ type: "response.incomplete", response: { ...completed([], "incomplete"), incomplete_details: { reason: "max_output_tokens" } } }],
    [{ type: "error", message: "stream error" }],
    [{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"query":' }],
  ]) {
    const { http } = mockHttp([sse(events)]);
    await assert.rejects(createLlm(config, { fetch: http }).stream(basic));
  }
});

test("terminal-only output and refusals are surfaced without exposing reasoning summaries", async () => {
  const { http } = mockHttp([terminal([{ type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "internal summary" }] }, message("Final.")]),
    sse([{ type: "response.refusal.delta", delta: "Cannot comply." }, { type: "response.completed", response: completed([{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Cannot comply." }] }]) }]),
  ]);
  const llm = createLlm(config, { fetch: http });
  const deltas: string[] = [];
  await llm.stream({ ...basic, onText: text => deltas.push(text) });
  assert.deepEqual(deltas, ["Final."]);
  assert.equal((await llm.stream(basic)).text, "Cannot comply.");
});

test("plain assistant/tool history can be translated without duplicating preserved output", () => {
  const output: ModelOutputItem[] = [{ type: "function_call", name: "web_search", arguments: "{}", call_id: "call-1" }];
  assert.deepEqual(responsesInput([
    { role: "system", content: "rules" }, { role: "assistant", content: "past answer" },
    { role: "assistant", content: "ignored duplicate", tool_calls: [{ id: "call-1", type: "function", function: { name: "web_search", arguments: "{}" } }], responseOutput: output },
    { role: "tool", tool_call_id: "call-1", content: "evidence" },
  ]), [{ role: "system", content: "rules" }, { role: "assistant", content: "past answer" }, ...output, { type: "function_call_output", call_id: "call-1", output: "evidence" }]);
});

test("Chat Completions remains the default for existing compatible model hosts", async () => {
  const { http, requests } = mockHttp([sse([{ choices: [{ delta: { content: "Hello." } }] }])]);
  const result = await createLlm({ ...config, apiMode: undefined }, { fetch: http }).stream(basic);
  assert.equal(result.text, "Hello.");
  assert.equal(requests[0]!.url, "https://example.com/openai/v1/chat/completions");
  assert.equal(requests[0]!.body.tools[0].function.name, "web_search");
});

test("Responses usage reports billed token categories without double-counting reasoning", async () => {
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 25, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 125 };
  const { http } = mockHttp([sse([{ type: "response.output_text.delta", delta: "Done." }, { type: "response.completed", response: { ...completed([message("Done.")]), model: "sol-deployment", usage } }])]);
  const records: import("../src/llm.ts").LlmUsage[] = [];
  await createLlm(config, { fetch: http, onUsage: record => records.push(record) }).stream(basic);
  assert.deepEqual(records, [{ model: "sol-deployment", inputTokens: 100, cachedInputTokens: 40, outputTokens: 25, reasoningTokens: 10 }]);
});
