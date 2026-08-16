import OpenAI from "openai";

let client: OpenAI | null = null;

export function hasModelAccess(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function modelName(): string {
  return process.env.OPENAI_MODEL ?? "gpt-5-mini";
}

export function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const configuredTimeout = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);
  const timeout = Number.isFinite(configuredTimeout)
    ? Math.max(5_000, Math.min(120_000, configuredTimeout))
    : 60_000;
  // Interactive review must degrade predictably; provider-grounded heuristics are the safe fallback.
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout, maxRetries: 0 });
  return client;
}
