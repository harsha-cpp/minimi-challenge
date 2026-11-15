import { existsSync } from "node:fs";
import { validateAccessPolicy, type AccessPolicy } from "./runtime/access.ts";
import type { LlmConfig } from "./llm.ts";

export interface Config {
  port: number;
  dbPath: string;
  temporalDbPath: string;
  llm: LlmConfig | null;
  exaApiKey: string | null;

  startAt: Date | null;

  missing: string[];
  access: AccessPolicy;
  host: string;
  limits: { activeTurns: number; queuedTurns: number; activeModels: number; queuedModels: number; modelRequestsPerMinute: number; modelTokensPerMinute: number; modelCompletionRequests?: number; modelCompletionTokens?: number; turnTimeoutMs: number; turnTokens: number; turnModelCalls: number; maxOutputTokens: number; shutdownMs: number; traceRetentionDays: number; maxTurnDollars: number; searchAttemptDollars?: number | null; inputDollarsPerMillion: number | null; outputDollarsPerMillion: number | null };
  retrievalProfiles: boolean;
}

export function loadConfig(): Config {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = (name: string) => process.env[name]?.trim() || "";

  const missing = ["LLM_API_KEY", "LLM_MODEL", "EXA_API_KEY"].filter((name) => !env(name));
  const apiMode = env("LLM_API_MODE") || "chat_completions";
  if (apiMode !== "responses" && apiMode !== "chat_completions") throw new Error("LLM_API_MODE must be responses or chat_completions");
  if (env("LLM_TOKEN_LIMIT_PARAMETER") && !["max_tokens", "max_completion_tokens"].includes(env("LLM_TOKEN_LIMIT_PARAMETER"))) throw new Error("Invalid LLM_TOKEN_LIMIT_PARAMETER.");
  const startAt = env("AGENT_NOW") ? new Date(env("AGENT_NOW")) : null;
  if (startAt && Number.isNaN(startAt.getTime())) throw new Error(`AGENT_NOW is not a valid date: ${env("AGENT_NOW")}`);

  const integer = (name: string, fallback: number, min = 1, max = 1_000_000) => {
    const value = env(name) ? Number(env(name)) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is outside its allowed integer range.`);
    return value;
  };
  const price = (name: string): number | null => {
    if (!env(name)) return null;
    const value = Number(env(name));
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a nonnegative number.`);
    return value;
  };
  const access: AccessPolicy = { mode: (env("DEPLOYMENT_MODE") || "local") as AccessPolicy["mode"],
    allowedOrigins: env("ALLOWED_ORIGINS").split(",").filter(Boolean).map(value => value.trim()),
    ownerTokens: env("OWNER_TOKENS") ? JSON.parse(env("OWNER_TOKENS")) : {},
    ...(env("PUBLIC_DEMO") === "1" ? { publicSessionSecret: env("PUBLIC_SESSION_SECRET") } : {}) };
  if (env("PUBLIC_DEMO") && !["0", "1"].includes(env("PUBLIC_DEMO"))) throw new Error("PUBLIC_DEMO must be 0 or 1.");
  validateAccessPolicy(access);
  if (access.mode === "hosted" && (price("INPUT_DOLLARS_PER_MILLION") === null || price("OUTPUT_DOLLARS_PER_MILLION") === null)) throw new Error("Hosted mode requires explicit model input/output prices for spend admission.");
  const searchAttemptDollars = price("SEARCH_MAX_ATTEMPT_DOLLARS");
  if (searchAttemptDollars === 0 || (access.mode === "hosted" && searchAttemptDollars === null)) throw new Error("SEARCH_MAX_ATTEMPT_DOLLARS must be an explicit positive attempt bound in hosted mode.");
  if (price("MAX_TURN_DOLLARS") === 0) throw new Error("MAX_TURN_DOLLARS must be positive.");
  const activeTurns = integer("MAX_ACTIVE_TURNS", 4, 1, 64);
  const turnTokens = integer("MAX_TURN_TOKENS", 100_000, 4096);
  const modelRequestsPerMinute = integer("MODEL_REQUESTS_PER_MINUTE", 120, 1, 10000);
  const modelTokensPerMinute = integer("MODEL_TOKENS_PER_MINUTE", 1_000_000, 4096, 100_000_000);
  const modelCompletionRequests = integer("MODEL_COMPLETION_REQUEST_RESERVE", Math.min(activeTurns * 2, modelRequestsPerMinute), 0, modelRequestsPerMinute);
  const modelCompletionTokens = integer("MODEL_COMPLETION_TOKEN_RESERVE", Math.min(activeTurns * turnTokens, Math.floor(modelTokensPerMinute / 2)), 0, modelTokensPerMinute);
  return {
    access, host: access.mode === "local" ? "127.0.0.1" : "0.0.0.0",
    retrievalProfiles: env("RETRIEVAL_PROFILES") === "1",
    limits: { activeTurns, queuedTurns: integer("MAX_QUEUED_TURNS", 16, 0, 256),
      activeModels: integer("MAX_ACTIVE_MODELS", 4, 1, 64), queuedModels: integer("MAX_QUEUED_MODELS", 24, 0, 256),
      modelRequestsPerMinute, modelTokensPerMinute, modelCompletionRequests, modelCompletionTokens,
      turnTimeoutMs: integer("TURN_TIMEOUT_MS", 120_000, 1000, 300_000), turnTokens,
      turnModelCalls: integer("MAX_TURN_MODEL_CALLS", 10, 1, 32), maxOutputTokens: integer("MAX_OUTPUT_TOKENS", 4096, 256, 32_768),
      shutdownMs: integer("SHUTDOWN_MS", 10_000, 100, 30_000), traceRetentionDays: integer("TRACE_RETENTION_DAYS", 14, 1, 365),
      maxTurnDollars: price("MAX_TURN_DOLLARS") ?? 1, searchAttemptDollars, inputDollarsPerMillion: price("INPUT_DOLLARS_PER_MILLION"), outputDollarsPerMillion: price("OUTPUT_DOLLARS_PER_MILLION") },
    port: Number(env("PORT")) || 3000,
    dbPath: env("DB_PATH") || "data/asof.db",
    temporalDbPath: env("TEMPORAL_DB_PATH") || `${env("DB_PATH") || "data/asof.db"}.temporal.db`,
    llm:
      env("LLM_API_KEY") && env("LLM_MODEL")
        ? {
            apiKey: env("LLM_API_KEY"),
            model: env("LLM_MODEL"),
            baseUrl: env("LLM_BASE_URL") || undefined,
            fastModel: env("LLM_FAST_MODEL") || undefined,
            reasoningEffort: env("LLM_REASONING_EFFORT") || undefined,
            apiMode,
            ...(env("LLM_TOKEN_LIMIT_PARAMETER") ? { tokenLimitParameter: env("LLM_TOKEN_LIMIT_PARAMETER") as "max_tokens" | "max_completion_tokens" } : {}),
            ...(env("LLM_STREAM_USAGE") === "0" ? { supportsStreamUsage: false } : {}),
          }
        : null,
    exaApiKey: env("EXA_API_KEY") || null,
    startAt,
    missing,
  };
}
