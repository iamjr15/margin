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
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
  return client;
}
