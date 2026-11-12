import { existsSync } from "node:fs";
import type { LlmConfig } from "./llm.ts";

export interface Config {
  port: number;
  dbPath: string;
  llm: LlmConfig | null;
  exaApiKey: string | null;
  /** Where to start the clock, when AGENT_NOW is set. */
  startAt: Date | null;
  /** Required env vars that are not set. The server still starts and the page says what is missing. */
  missing: string[];
}

export function loadConfig(): Config {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = (name: string) => process.env[name]?.trim() || "";

  const missing = ["LLM_API_KEY", "LLM_MODEL", "EXA_API_KEY"].filter((name) => !env(name));
  const startAt = env("AGENT_NOW") ? new Date(env("AGENT_NOW")) : null;
  if (startAt && Number.isNaN(startAt.getTime())) throw new Error(`AGENT_NOW is not a valid date: ${env("AGENT_NOW")}`);

  return {
    port: Number(env("PORT")) || 3000,
    dbPath: env("DB_PATH") || "data/asof.db",
    llm:
      env("LLM_API_KEY") && env("LLM_MODEL")
        ? {
            apiKey: env("LLM_API_KEY"),
            model: env("LLM_MODEL"),
            baseUrl: env("LLM_BASE_URL") || undefined,
            fastModel: env("LLM_FAST_MODEL") || undefined,
            reasoningEffort: env("LLM_REASONING_EFFORT") || undefined,
          }
        : null,
    exaApiKey: env("EXA_API_KEY") || null,
    startAt,
    missing,
  };
}
