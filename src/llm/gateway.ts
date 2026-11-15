import { AsyncLocalStorage } from "node:async_hooks";
import { MODEL_LIMITS, type Llm, type LlmUsage, type ModelPurpose, type StreamRequest, type JsonRequest } from "../llm.ts";

export type WorkPriority = "foreground" | "background";
export class AdmissionError extends Error {
  constructor(readonly code: "busy" | "deadline" | "closed" | "budget", message: string) { super(message); this.name = "AdmissionError"; }
}
export interface AdmissionOptions { ownerId: string; priority?: WorkPriority; completion?: boolean; signal?: AbortSignal; deadlineAt?: number; }
interface Waiter extends AdmissionOptions { priority: WorkPriority; ready(release: () => void): void; reject(reason: unknown): void; cleanup(): void; }
/** One process-wide pool should be shared by generation, review and enrichment. */
export class AdmissionPool {
  private active = 0;
  private backgroundActive = 0;
  private activeByOwner = new Map<string, number>();
  private waiting: Waiter[] = [];
  private stopped = false;
  private rejected = 0;
  private lastOwner: Record<WorkPriority, string | undefined> = { foreground: undefined, background: undefined };
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly foregroundReserve: number;
  readonly maxPerOwner: number;
  constructor(options: { maxActive: number; maxQueued: number; foregroundReserve?: number; maxPerOwner?: number }) {
    this.maxActive = options.maxActive;
    this.maxQueued = options.maxQueued;
    this.foregroundReserve = options.foregroundReserve ?? Math.min(1, options.maxActive - 1);
    this.maxPerOwner = options.maxPerOwner ?? options.maxActive;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1 || !Number.isInteger(this.maxQueued) || this.maxQueued < 0
      || !Number.isInteger(this.foregroundReserve) || this.foregroundReserve < 0 || this.foregroundReserve >= this.maxActive
      || !Number.isInteger(this.maxPerOwner) || this.maxPerOwner < 1 || this.maxPerOwner > this.maxActive) throw new Error("Invalid admission limits.");
  }
  get stats() { return { active: this.active, queued: this.waiting.length, backgroundActive: this.backgroundActive, rejected: this.rejected, closed: this.stopped }; }
  async acquire(options: AdmissionOptions): Promise<() => void> {
    options.signal?.throwIfAborted();
    if (this.stopped) throw new AdmissionError("closed", "Service is shutting down.");
    if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) throw new AdmissionError("deadline", "Insufficient time remains to start this work.");
    const priority = options.priority ?? "foreground";
    if (!this.waiting.some(item => item.priority === priority) && this.canStart(options.ownerId, priority)) return this.start(options.ownerId, priority);
    if (this.waiting.length >= this.maxQueued) { this.rejected++; throw new AdmissionError("busy", "Service is busy; try again shortly."); }
    return new Promise<() => void>((ready, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        waiter.cleanup();
        reject(options.signal?.aborted ? options.signal.reason : new AdmissionError("deadline", "Queued work exceeded its deadline."));
        this.dispatch();
      };
      const waiter: Waiter = { ...options, priority, ready, reject, cleanup: () => {
        options.signal?.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
      } };
      this.waiting.push(waiter);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.deadlineAt !== undefined) timer = setTimeout(abort, Math.max(1, Math.min(2_147_483_647, options.deadlineAt - Date.now())));
      this.dispatch();
    });
  }
  close(): void {
    this.stopped = true;
    for (const waiter of this.waiting.splice(0)) { waiter.cleanup(); waiter.reject(new AdmissionError("closed", "Service is shutting down.")); }
  }
  private canStart(owner: string, priority: WorkPriority): boolean {
    return this.active < this.maxActive && (this.activeByOwner.get(owner) ?? 0) < this.maxPerOwner
      && (priority !== "background" || this.backgroundActive < this.maxActive - this.foregroundReserve);
  }
  private start(owner: string, priority: WorkPriority): () => void {
    this.active++;
    if (priority === "background") this.backgroundActive++;
    this.activeByOwner.set(owner, (this.activeByOwner.get(owner) ?? 0) + 1);
    this.lastOwner[priority] = owner;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (priority === "background") this.backgroundActive--;
      const remaining = (this.activeByOwner.get(owner) ?? 1) - 1;
      if (remaining) this.activeByOwner.set(owner, remaining); else this.activeByOwner.delete(owner);
      this.dispatch();
    };
  }
  private dispatch(): void {
    if (this.stopped) return;
    while (this.active < this.maxActive) {
      let selected = -1;
      for (const priority of ["foreground", "background"] as const) {
        let eligible = this.waiting.map((item, index) => ({ item, index })).filter(({ item }) => item.priority === priority && this.canStart(item.ownerId, priority));
        if (priority === "foreground" && eligible.some(({ item }) => item.completion)) eligible = eligible.filter(({ item }) => item.completion);
        if (eligible.length) { selected = (eligible.find(({ item }) => item.ownerId !== this.lastOwner[priority]) ?? eligible[0])!.index; break; }
      }
      if (selected === -1) return;
      const [waiter] = this.waiting.splice(selected, 1);
      waiter!.cleanup();
      if (waiter!.signal?.aborted || (waiter!.deadlineAt !== undefined && waiter!.deadlineAt <= Date.now())) {
        waiter!.reject(waiter!.signal?.aborted ? waiter!.signal.reason : new AdmissionError("deadline", "Queued work exceeded its deadline."));
        continue;
      }
      waiter!.ready(this.start(waiter!.ownerId, waiter!.priority));
    }
  }
}

export interface ModelPrices { version: string; inputPerMillionUsd: number; outputPerMillionUsd: number; cachedInputPerMillionUsd?: number; }
export interface ModelBudgetOptions {
  maxCalls?: number;
  maxTokens?: number;
  maxSpendUsd?: number;
  prices?: ModelPrices;
  reserveCalls?: number;
  reserveTokens?: number;
}
/** Usage without provider reporting is charged conservatively, never recorded as zero. */
export class ModelBudget {
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly reserveCalls: number;
  readonly reserveTokens: number;
  private calls = 0;
  private tokens = 0;
  private spend = 0;
  private knownUsageCalls = 0;
  private missingUsageCalls = 0;
  private externalCalls = 0;
  private unknownExternalUsage = 0;
  private externalSpend = 0;
  private unboundedExternalUsage = 0;
  private externalBoundViolations = 0;
  private completionCostEstimate = 0;
  constructor(readonly options: ModelBudgetOptions = {}) {
    this.maxCalls = options.maxCalls ?? 12;
    this.maxTokens = options.maxTokens ?? 160_000;
    this.reserveCalls = options.reserveCalls ?? Math.min(2, this.maxCalls - 1);
    this.reserveTokens = options.reserveTokens ?? Math.min(12_000, Math.floor(this.maxTokens / 3));
    if (!Number.isInteger(this.maxCalls) || this.maxCalls < 1 || !Number.isInteger(this.maxTokens) || this.maxTokens < 1
      || !Number.isInteger(this.reserveCalls) || this.reserveCalls < 0 || this.reserveCalls >= this.maxCalls
      || !Number.isInteger(this.reserveTokens) || this.reserveTokens < 0 || this.reserveTokens >= this.maxTokens) throw new Error("Invalid model budget.");
    if (options.maxSpendUsd !== undefined && (!Number.isFinite(options.maxSpendUsd) || options.maxSpendUsd <= 0 || !options.prices)) throw new Error("A spend cap requires a positive budget and a versioned model price table.");
    if (options.prices && (!options.prices.version || [options.prices.inputPerMillionUsd, options.prices.outputPerMillionUsd, options.prices.cachedInputPerMillionUsd ?? 0].some(value => !Number.isFinite(value) || value < 0))) throw new Error("Invalid model price table.");
  }
  get snapshot() { return { calls: this.calls, tokens: this.tokens,
    spendUsd: this.options.prices && !this.unboundedExternalUsage ? this.spend : null,
    priceVersion: this.options.prices?.version ?? null, spendIsEstimated: this.missingUsageCalls > 0 || this.unknownExternalUsage > 0,
    spendCapEnforced: this.options.maxSpendUsd !== undefined,
    knownUsageCalls: this.knownUsageCalls, missingUsageCalls: this.missingUsageCalls,
    externalCalls: this.externalCalls, unknownExternalUsage: this.unknownExternalUsage,
    externalSpendUsd: this.unknownExternalUsage ? null : this.externalSpend,
    externalSpendEstimateUsd: this.unboundedExternalUsage ? null : this.externalSpend,
    externalBoundViolations: this.externalBoundViolations }; }
  reserve(inputTokens: number, outputTokenCap: number, purpose: ModelPurpose) {
    const terminal = purpose === "synthesis" || purpose === "review" || purpose === "repair";
    const tokenEstimate = inputTokens + outputTokenCap;
    const estimatedCost = this.price(inputTokens, outputTokenCap, 0);
    if (this.calls + 1 > this.maxCalls - (terminal ? 0 : this.reserveCalls)
      || this.tokens + tokenEstimate > this.maxTokens - (terminal ? 0 : Math.max(this.reserveTokens, tokenEstimate))
      || (this.options.maxSpendUsd !== undefined && this.spend + estimatedCost + (terminal ? 0 : Math.max(estimatedCost, this.price(this.reserveTokens, 0, 0))) > this.options.maxSpendUsd)) throw new AdmissionError("budget", "The turn's model budget is exhausted.");
    this.completionCostEstimate = Math.max(this.completionCostEstimate, estimatedCost);
    this.calls++;
    this.tokens += tokenEstimate;
    this.spend += estimatedCost;
    let settled = false;
    return {
      cancel: () => {
        if (settled) return;
        settled = true;
        this.calls--; this.tokens -= tokenEstimate; this.spend -= estimatedCost;
      },
      settle: (usage: LlmUsage | null) => {
        if (settled) return;
        settled = true;
        if (!usage || !validUsage(usage)) { this.missingUsageCalls++; return; }
        this.knownUsageCalls++;
        this.tokens += usage.inputTokens + usage.outputTokens - tokenEstimate;
        this.spend += this.price(usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) - estimatedCost;
        if (this.tokens > this.maxTokens || (this.options.maxSpendUsd !== undefined && this.spend > this.options.maxSpendUsd)) throw new AdmissionError("budget", "The turn's provider-reported usage exceeded its budget.");
      },
    };
  }
  /** Each uncached provider attempt reserves its configured maximum; retries reserve separately. */
  reserveExternal(maxDollars: number | null) {
    if (maxDollars !== null && (!Number.isFinite(maxDollars) || maxDollars < 0)) throw new AdmissionError("budget", "Invalid external-provider spend reservation.");
    if (maxDollars === null && this.options.maxSpendUsd !== undefined) throw new AdmissionError("budget", "A spend cap requires an explicit external-provider attempt bound.");
    const completionReserve = Math.max(this.completionCostEstimate, this.price(this.reserveTokens, MODEL_LIMITS.outputTokens, 0));
    if (this.externalBoundViolations || (this.options.maxSpendUsd !== undefined && this.spend + (maxDollars ?? 0) + completionReserve > this.options.maxSpendUsd)) throw new AdmissionError("budget", "The turn's provider spend budget is exhausted.");
    const reserved = maxDollars ?? 0;
    this.externalCalls++;
    this.externalSpend += reserved;
    this.spend += reserved;
    let settled = false;
    return {
      cancel: () => {
        if (settled) return;
        settled = true;
        this.externalCalls--; this.externalSpend -= reserved; this.spend -= reserved;
      },
      settle: (actualDollars: number | null) => {
        if (settled) return;
        settled = true;
        if (actualDollars === null || !Number.isFinite(actualDollars) || actualDollars < 0) {
          this.unknownExternalUsage++;
          if (maxDollars === null) this.unboundedExternalUsage++;
          return;
        }
        this.externalSpend += actualDollars - reserved;
        this.spend += actualDollars - reserved;
        if (maxDollars !== null && actualDollars > maxDollars) {
          this.externalBoundViolations++;
          throw new AdmissionError("budget", "The provider-reported cost exceeded its configured attempt bound.");
        }
        if (this.options.maxSpendUsd !== undefined && this.spend > this.options.maxSpendUsd) throw new AdmissionError("budget", "The turn's provider-reported spend exceeded its budget.");
      },
    };
  }
  private price(input: number, output: number, cached: number): number {
    const prices = this.options.prices;
    if (!prices) return 0;
    return ((input - cached) * prices.inputPerMillionUsd + cached * (prices.cachedInputPerMillionUsd ?? prices.inputPerMillionUsd) + output * prices.outputPerMillionUsd) / 1_000_000;
  }
}
function validUsage(usage: LlmUsage): boolean {
  return [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.reasoningTokens].every(value => Number.isInteger(value) && value >= 0)
    && usage.cachedInputTokens <= usage.inputTokens && usage.reasoningTokens <= usage.outputTokens;
}
/** Sliding-window account quota, shared across every gateway using the same provider account. */
export class ModelQuota {
  private entries: Array<{ at: number; tokens: number }> = [];
  readonly completionRequests: number;
  readonly completionTokens: number;
  constructor(readonly limits: { requestsPerMinute: number; tokensPerMinute: number; completionRequests?: number; completionTokens?: number }, private now: () => number = Date.now) {
    this.completionRequests = limits.completionRequests ?? Math.min(4, Math.max(0, limits.requestsPerMinute - 1));
    this.completionTokens = limits.completionTokens ?? Math.min(48_000, Math.floor(limits.tokensPerMinute / 4));
    if (!Number.isInteger(limits.requestsPerMinute) || limits.requestsPerMinute < 1 || !Number.isInteger(limits.tokensPerMinute) || limits.tokensPerMinute < 1) throw new Error("Invalid provider quota.");
    if (!Number.isInteger(this.completionRequests) || this.completionRequests < 0 || this.completionRequests > limits.requestsPerMinute
      || !Number.isInteger(this.completionTokens) || this.completionTokens < 0 || this.completionTokens > limits.tokensPerMinute) throw new Error("Invalid provider completion reserve.");
  }
  reserve(tokens: number, options: { completion?: boolean } = {}) {
    const at = this.now();
    this.entries = this.entries.filter(entry => entry.at > at - 60_000);
    const usedTokens = this.entries.reduce((sum, entry) => sum + entry.tokens, 0);
    if (this.entries.length >= this.limits.requestsPerMinute || usedTokens + tokens > this.limits.tokensPerMinute) throw new AdmissionError("busy", "Model account quota is busy; retry later.");
    if (!options.completion && (this.entries.length >= this.limits.requestsPerMinute - this.completionRequests || usedTokens + tokens > this.limits.tokensPerMinute - this.completionTokens)) throw new AdmissionError("budget", "The remaining model account quota is reserved for completion.");
    const entry = { at, tokens };
    this.entries.push(entry);
    return { settle: (usage: LlmUsage | null) => { if (usage && validUsage(usage)) entry.tokens = usage.inputTokens + usage.outputTokens; },
      cancel: () => { const index = this.entries.indexOf(entry); if (index !== -1) this.entries.splice(index, 1); } };
  }
  get stats() {
    const at = this.now();
    const entries = this.entries.filter(entry => entry.at > at - 60_000);
    return { requests: entries.length, tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0), completionRequests: this.completionRequests, completionTokens: this.completionTokens };
  }
}
export interface ModelCallTrace {
  providerStarted: boolean;
  turnId?: string;
  purpose: ModelPurpose;
  priority: WorkPriority;
  queueMs: number;
  durationMs: number;
  firstDeltaMs: number | null;
  outcome: string;
  usage: LlmUsage | null;
  budget: ModelBudget["snapshot"];
}
export interface ModelContext {
  turnId?: string;
  ownerId: string;
  priority?: WorkPriority;
  deadlineAt?: number;
  deadlineReserveMs?: number;
  budget?: ModelBudget;
  onCall?: (trace: ModelCallTrace) => void;
}
const context = new AsyncLocalStorage<ModelContext>();
export function runWithModelContext<T>(value: ModelContext, fn: () => T): T { return context.run(value, fn); }
export function currentModelContext(): ModelContext | undefined { return context.getStore(); }

export function createModelGateway(llm: Llm, options: { pool: AdmissionPool; defaultBudget?: ModelBudgetOptions; onCall?: (trace: ModelCallTrace) => void; quota?: ModelQuota; outputTokens?: number; jsonOutputTokens?: number }): Llm {
  async function call<T>(kind: "stream" | "json", request: StreamRequest | JsonRequest, invoke: (request: StreamRequest | JsonRequest) => Promise<T>): Promise<T> {
    const active = context.getStore();
    const priority = request.purpose === "enrichment" ? "background" : active?.priority ?? "foreground";
    const purpose = request.purpose ?? (kind === "json" ? priority === "background" ? "enrichment" : "review" : (request as StreamRequest).toolChoice === "none" ? "synthesis" : "research");
    const budget = active?.budget ?? new ModelBudget(options.defaultBudget);
    const cap = Math.min(request.maxOutputTokens ?? (kind === "json" ? options.jsonOutputTokens ?? MODEL_LIMITS.jsonOutputTokens : options.outputTokens ?? MODEL_LIMITS.outputTokens), 32_768);
    if (!Number.isInteger(cap) || cap < 1) throw new AdmissionError("budget", "Invalid requested model output limit.");
    // UTF-8 byte length is deliberately conservative across languages and tokenizers.
    const inputTokens = Buffer.byteLength(JSON.stringify(kind === "json" ? [(request as JsonRequest).system, (request as JsonRequest).user] : [(request as StreamRequest).messages, (request as StreamRequest).tools])) + 128;
    let reservation: ReturnType<ModelBudget["reserve"]> | undefined;
    const began = performance.now();
    let acquiredAt: number | undefined, firstDeltaMs: number | null = null, usage: LlmUsage | null = null, outcome = "completed", providerStarted = false;
    let release: (() => void) | undefined;
    let quotaReservation: ReturnType<ModelQuota["reserve"]> | undefined;
    let effectiveSignal = request.signal, invocationSettled = true, keepLease = false, finished = false;
    try {
      reservation = budget.reserve(inputTokens, cap, purpose);
      const research = purpose === "research" || purpose === "enrichment";
      const deadlineAt = active?.deadlineAt === undefined ? undefined : active.deadlineAt - (research ? active.deadlineReserveMs ?? 10_000 : 0);
      release = await options.pool.acquire({ ownerId: active?.ownerId ?? "local", priority, completion: purpose === "synthesis" || purpose === "review" || purpose === "repair", signal: request.signal, deadlineAt });
      acquiredAt = performance.now();
      request.signal?.throwIfAborted();
      quotaReservation = options.quota?.reserve(inputTokens + cap, { completion: purpose === "synthesis" || purpose === "review" || purpose === "repair" });
      providerStarted = true;
      const remainingMs = active?.deadlineAt === undefined ? undefined : Math.max(1, active.deadlineAt - Date.now());
      const deadlineSignal = remainingMs === undefined ? undefined : AbortSignal.timeout(remainingMs);
      const signal = request.signal && deadlineSignal ? AbortSignal.any([request.signal, deadlineSignal]) : request.signal ?? deadlineSignal;
      effectiveSignal = signal;
      const wrapped: StreamRequest | JsonRequest = { ...request, signal, maxOutputTokens: cap, onUsage: value => { if (!finished) { usage = value; request.onUsage?.(value); } } };
      if (kind === "stream") (wrapped as StreamRequest).onText = delta => { if (finished || signal?.aborted) return; firstDeltaMs ??= Math.round(performance.now() - acquiredAt!); (request as StreamRequest).onText(delta); };
      invocationSettled = false;
      const invocation = Promise.resolve().then(() => invoke(wrapped)).finally(() => { invocationSettled = true; if (keepLease) release?.(); });
      return await withSignal(invocation, signal);
    } catch (error) {
      if (error && typeof error === "object" && "providerStarted" in error && typeof error.providerStarted === "boolean") providerStarted = error.providerStarted;
      if (!providerStarted) quotaReservation?.cancel();
      const reason: unknown = effectiveSignal?.aborted ? effectiveSignal.reason : error;
      const name = reason && typeof reason === "object" && "name" in reason ? reason.name : undefined;
      outcome = name === "TimeoutError" ? "timeout" : effectiveSignal?.aborted || name === "AbortError" ? "cancelled"
        : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "error";
      throw error;
    } finally {
      finished = true;
      // A provider that ignores abort cannot release capacity for additional unbounded work.
      keepLease = !invocationSettled;
      try {
        if (providerStarted) { quotaReservation?.settle(usage); reservation?.settle(usage); } else reservation?.cancel();
      } catch (error) { outcome = "budget"; throw error; }
      finally {
        if (!keepLease) release?.();
        const ended = performance.now();
        const trace: ModelCallTrace = { providerStarted, ...(active?.turnId ? { turnId: active.turnId } : {}), purpose, priority,
          queueMs: Math.round((acquiredAt ?? ended) - began), durationMs: acquiredAt === undefined ? 0 : Math.round(ended - acquiredAt),
          firstDeltaMs, outcome, usage, budget: budget.snapshot };
        options.onCall?.(trace);
        active?.onCall?.(trace);
      }
    }
  }
  return {
    stream: request => call("stream", request, value => llm.stream(value as StreamRequest)),
    json: request => call("json", request, value => llm.json(value as JsonRequest)),
  };
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
