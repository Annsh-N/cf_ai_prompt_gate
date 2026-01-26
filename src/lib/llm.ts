export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };

export type LLMCallOptions = {
  model?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
};

export type LLMResult = {
  text: string;
  usage: { input_tokens?: number; output_tokens?: number } | null;
  raw: any;
  stream?: ReadableStream;
};

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => coerceText(item)).join("");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.response === "string") return record.response;
    if (typeof record.output === "string") return record.output;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

export async function callLLM(
  env: { AI: any },
  options: LLMCallOptions
): Promise<LLMResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const payload: Record<string, unknown> = {
    messages: options.messages,
    max_tokens: options.maxTokens ?? 512,
    temperature: options.temperature ?? 0.2,
  };

  if (options.stream) {
    payload.stream = true;
  }

  const result = await env.AI.run(model, payload);

  if (options.stream && result instanceof ReadableStream) {
    return {
      text: "",
      usage: null,
      raw: result,
      stream: result,
    };
  }

  const text =
    result?.response ??
    result?.text ??
    result?.result ??
    result?.output ??
    "";

  const usage = result?.usage ?? result?.metrics?.usage ?? null;

  return {
    text: coerceText(text),
    usage,
    raw: result,
  };
}
