import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmUsage } from "../llm.ts";

export const POLICY_VERSION = "grounded-recovery-v1";
type Metadata = Record<string, string | number | boolean | null>;
export interface Stage { name: string; ms: number; atMs: number; data?: Metadata }
export interface TurnTrace {
  version: 1; turnId: string; policyVersion: string; model: string | null; mode: string;
  receivedAt: string; outcome: string; quality?: string; stages: Stage[]; droppedStages: number;
  usage: LlmUsage[]; missingUsage: number; droppedUsage: number;
  serverFirstEmissionMs: number | null; clientFirstRenderMs: number | null; totalMs: number;
}
interface TraceContext { trace: TurnTrace; started: number; terminal: boolean; onLateUpdate?: (trace: TurnTrace) => void }
const context = new AsyncLocalStorage<TraceContext>();
export function newTrace(turnId: string, model: string | null, mode: string): TurnTrace {
  return { version: 1, turnId, policyVersion: POLICY_VERSION, model: model?.slice(0, 128) ?? null, mode: mode.slice(0, 64), receivedAt: new Date().toISOString(),
    outcome: "running", stages: [], droppedStages: 0, usage: [], missingUsage: 0, droppedUsage: 0,
    serverFirstEmissionMs: null, clientFirstRenderMs: null, totalMs: 0 };
}
export function withTrace<T>(trace: TurnTrace, fn: () => T, onLateUpdate?: (trace: TurnTrace) => void): T {
  return context.run({ trace, started: performance.now(), terminal: false, onLateUpdate }, fn);
}
function notifyLate(context: TraceContext): void { if (context.terminal) context.onLateUpdate?.(context.trace); }
export function currentTrace(): TurnTrace | undefined { return context.getStore()?.trace; }
export function recordStage(name: string, ms: number, data?: Metadata): void {
  const current = context.getStore();
  if (!current) return;
  if (current.trace.stages.length >= 128) { current.trace.droppedStages++; notifyLate(current); return; }
  // Call sites supply counters/enums only. Prompt, passage, query and provider errors are never metadata.
  const safe = data && Object.fromEntries(Object.entries(data).slice(0, 16)
    .filter(([key]) => !/prompt|text|key|secret|query|message|reasoning/i.test(key))
    .map(([key, value]) => [key.slice(0, 64), typeof value === "string" ? value.slice(0, 128) : value]));
  current.trace.stages.push({ name: name.slice(0, 64), ms: Math.max(0, Math.round(ms)),
    atMs: Math.round(performance.now() - current.started), ...(safe ? { data: safe } : {}) });
  notifyLate(current);
}
export async function traceStage<T>(name: string, fn: () => T | Promise<T>, data?: Metadata): Promise<T> {
  const started = performance.now();
  try { const result = await fn(); recordStage(name, performance.now() - started, { ...data, outcome: "success" }); return result; }
  catch (error) { recordStage(name, performance.now() - started, { ...data, outcome: "failed" }); throw error; }
}
export function recordUsage(usage?: LlmUsage): void {
  const current = context.getStore(); if (!current) return;
  const trace = current.trace;
  if (!usage || typeof usage.model !== "string" || ![usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningTokens]
    .every(value => Number.isSafeInteger(value) && value >= 0)) trace.missingUsage++;
  else if (trace.usage.length < 32) trace.usage.push({ model: usage.model.slice(0, 128), inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens });
  else trace.droppedUsage++;
  notifyLate(current);
}
export function serverEmission(): void {
  const current = context.getStore();
  if (current) current.trace.serverFirstEmissionMs ??= Math.round(performance.now() - current.started);
}
export function finishTrace(outcome: string): TurnTrace | undefined {
  const current = context.getStore();
  if (!current) return;
  current.terminal = true;
  current.trace.outcome = outcome;
  current.trace.totalMs = Math.round(performance.now() - current.started);
  return current.trace;
}
