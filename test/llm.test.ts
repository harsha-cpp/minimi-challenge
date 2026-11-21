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
  const answer = await createLlm(config, { spendPolicy: null, fetch: http }).stream({ ...basic, onText: text => deltas.push(text) });
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
  const llm = createLlm(config, { spendPolicy: null, fetch: http });
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
  const llm = createLlm(config, { spendPolicy: null, fetch: http });
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
  const llm = createLlm(config, { spendPolicy: null, fetch: http });
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
    await assert.rejects(createLlm(config, { spendPolicy: null, fetch: http }).stream(basic));
  }
});

test("terminal-only output is surfaced and refusals are classified without exposing reasoning summaries", async () => {
  const { http } = mockHttp([terminal([{ type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "internal summary" }] }, message("Final.")]),
    sse([{ type: "response.refusal.delta", delta: "Cannot comply." }, { type: "response.completed", response: completed([{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Cannot comply." }] }]) }]),
  ]);
  const llm = createLlm(config, { spendPolicy: null, fetch: http });
  const deltas: string[] = [];
  await llm.stream({ ...basic, onText: text => deltas.push(text) });
  assert.deepEqual(deltas, ["Final."]);
  await assert.rejects(llm.stream(basic), (error: any) => error.code === "refused");
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
  const { http, requests } = mockHttp([sse([{ choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] }])]);
  const result = await createLlm({ ...config, apiMode: undefined }, { spendPolicy: null, fetch: http }).stream(basic);
  assert.equal(result.text, "Hello.");
  assert.equal(requests[0]!.url, "https://example.com/openai/v1/chat/completions");
  assert.equal(requests[0]!.body.tools[0].function.name, "web_search");
});

test("Responses usage reports billed token categories without double-counting reasoning", async () => {
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 25, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 125 };
  const { http } = mockHttp([sse([{ type: "response.output_text.delta", delta: "Done." }, { type: "response.completed", response: { ...completed([message("Done.")]), model: "sol-deployment", usage } }])]);
  const records: import("../src/llm.ts").LlmUsage[] = [];
  await createLlm(config, { spendPolicy: null, fetch: http, onUsage: record => records.push(record) }).stream(basic);
  assert.deepEqual(records, [{ model: "sol-deployment", inputTokens: 100, cachedInputTokens: 40, outputTokens: 25, reasoningTokens: 10 }]);
});

for (const apiMode of ["chat_completions", "responses"] as const) {
  test(`${apiMode} requires a terminal completion, classifies rejection, and reports missing usage`, async () => {
    const cases: Array<{ events: unknown[]; code: string }> = apiMode === "chat_completions" ? [
      { events: [{ choices: [{ delta: { content: "unfinished" } }] }], code: "interrupted" },
      { events: [{ choices: [{ delta: { content: "unfinished" }, finish_reason: "length" }] }], code: "truncated" },
      { events: [{ choices: [{ delta: {}, finish_reason: "content_filter" }] }], code: "filtered" },
      { events: [{ choices: [{ delta: { refusal: "cannot comply" }, finish_reason: "stop" }] }], code: "refused" },
    ] : [
      { events: [{ type: "response.output_text.delta", delta: "unfinished" }], code: "interrupted" },
      { events: [{ type: "response.incomplete", response: { ...completed([], "incomplete"), incomplete_details: { reason: "max_output_tokens" } } }], code: "truncated" },
      { events: [{ type: "response.incomplete", response: { ...completed([], "incomplete"), incomplete_details: { reason: "content_filter" } } }], code: "filtered" },
      { events: [{ type: "response.completed", response: completed([{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "cannot comply" }] }]) }], code: "refused" },
    ];
    for (const fixture of cases) {
      const { http } = mockHttp([sse(fixture.events)]);
      const records: unknown[] = [], requests: unknown[] = [];
      const llm = createLlm({ ...config, apiMode }, { spendPolicy: null, fetch: http, onUsageStatus: value => records.push(value) });
      await assert.rejects(llm.stream({ ...basic, onUsage: value => requests.push(value) }), (error: any) => error.code === fixture.code);
      assert.deepEqual(records, [{ model: config.model, usage: null, outcome: fixture.code }]);
      assert.deepEqual(requests, [null]);
    }
  });

  test(`${apiMode} bounds output and incremental tool arguments before forwarding excess`, async () => {
    const long = "a".repeat(32_001), args = "a".repeat(16_001);
    const fixtures = apiMode === "chat_completions" ? [
      [{ choices: [{ delta: { content: long } }] }],
      [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "web_search", arguments: args } }] } }] }],
    ] : [
      [{ type: "response.output_text.delta", delta: long }],
      [{ type: "response.function_call_arguments.delta", output_index: 0, delta: args }],
    ];
    for (const events of fixtures) {
      const { http } = mockHttp([sse(events)]);
      const forwarded: string[] = [];
      await assert.rejects(createLlm({ ...config, apiMode }, { spendPolicy: null, fetch: http }).stream({ ...basic, onText: value => forwarded.push(value) }), (error: any) => error.code === "output_limit");
      assert.deepEqual(forwarded, []);
    }
  });

  test(`${apiMode} rejects invalid, duplicate and incomplete tool identities`, async () => {
    for (const fixture of [
      [{ id: "invalid id", name: "web_search", arguments: "{}" }],
      [{ id: "call-1", name: "web_search", arguments: "{}" }, { id: "call-1", name: "web_search", arguments: "{}" }],
      [{ id: "call-1", name: "unknown_tool", arguments: "{}" }],
      [{ id: "call-1", name: "web_search", arguments: '{"query":' }],
    ]) {
      const events = apiMode === "chat_completions" ? [{ choices: [{ delta: { tool_calls: fixture.map((call, index) => ({ index, id: call.id, function: { name: call.name, arguments: call.arguments } })) }, finish_reason: "tool_calls" }] }] :
        [{ type: "response.completed", response: completed(fixture.map(call => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" }))) }];
      const { http } = mockHttp([sse(events)]);
      await assert.rejects(createLlm({ ...config, apiMode }, { spendPolicy: null, fetch: http }).stream(basic), (error: any) => error.code === "invalid_tool");
    }
  });

  test(`${apiMode} reports supplied usage on failed answers without leaking provider details`, async () => {
    const usage = apiMode === "chat_completions" ? { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } : { input_tokens: 100, output_tokens: 25, total_tokens: 125 };
    const events = apiMode === "chat_completions" ? [
      { choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }, { model: config.model, choices: [], usage },
    ] : [{ type: "response.incomplete", response: { ...completed([], "incomplete"), model: config.model, usage, incomplete_details: { reason: "max_output_tokens" }, error: { message: "private-provider-payload" } } }];
    const { http } = mockHttp([sse(events)]), records: unknown[] = [];
    await assert.rejects(createLlm({ ...config, apiMode }, { spendPolicy: null, fetch: http, onUsage: value => records.push(value) }).stream(basic), (error: any) => error.code === "truncated" && !error.message.includes("private-provider-payload"));
    assert.deepEqual(records, [{ model: config.model, inputTokens: 100, cachedInputTokens: 0, outputTokens: 25, reasoningTokens: 0 }]);
  });

  test(`${apiMode} JSON rejects truncated syntactically valid objects and sends a token ceiling`, async () => {
    const payload = apiMode === "chat_completions" ? { choices: [{ message: { content: '{"valid":true}' }, finish_reason: "length" }] } :
      { ...completed([message('{"valid":true}')], "incomplete"), incomplete_details: { reason: "max_output_tokens" } };
    const { http, requests } = mockHttp([Response.json(payload)]);
    await assert.rejects(createLlm({ ...config, apiMode }, { spendPolicy: null, fetch: http }).json({ system: "json", user: "test", maxOutputTokens: 512 }), (error: any) => error.code === "truncated");
    assert.equal(requests[0]!.body[apiMode === "responses" ? "max_output_tokens" : "max_completion_tokens"], 512);
  });
}

test("Chat Completions exposes usage, capability overrides and bounded successful tool calls", async () => {
  const { http, requests } = mockHttp([sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "web_search", arguments: '{"query":"one"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], model: "wire-model", usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 5 } } },
  ])]);
  const records: unknown[] = [];
  const result = await createLlm({ ...config, apiMode: "chat_completions", tokenLimitParameter: "max_tokens", supportsStreamUsage: false }, { spendPolicy: null, fetch: http, onUsage: value => records.push(value) }).stream({ ...basic, maxOutputTokens: 1000 });
  assert.equal(result.completion, "completed"); assert.equal(result.toolCalls[0]!.id, "call-1");
  assert.equal(requests[0]!.body.max_tokens, 1000); assert.equal(requests[0]!.body.max_completion_tokens, undefined); assert.equal(requests[0]!.body.stream_options, undefined);
  assert.deepEqual(records, [{ model: "wire-model", inputTokens: 80, outputTokens: 20, cachedInputTokens: 10, reasoningTokens: 5 }]);
});
