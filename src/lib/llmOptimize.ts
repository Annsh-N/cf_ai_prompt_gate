import { callLLM, DEFAULT_MODEL, type LLMMessage } from "./llm";

export type OptimizationLevel = "light" | "aggressive";

export type LLMOptimizeOutput = {
  optimized_prompt: string;
  notes: string[];
  preserved_constraints: string[];
  dropped_constraints: string[];
  level: OptimizationLevel;
};

type OptimizeOptions = {
  level: OptimizationLevel;
  model?: string;
  fixIssues?: string[];
  preserveConstraints?: string[];
};

const BASE_SYSTEM = `You are a prompt compiler. You MUST return STRICT JSON only with no extra text.\n\nOutput schema:\n{\n  "optimized_prompt": "string",\n  "notes": ["string"],\n  "preserved_constraints": ["string"],\n  "dropped_constraints": ["string"],\n  "level": "light"|"aggressive"\n}\n\nRules:\n- Only optimize the provided redacted prompt. Never invent facts.\n- Preserve user intent and all constraints unless explicitly impossible.\n- Remove repeated instructions; each instruction should appear once.\n- Do not include any repeated lines or repeated bullet points.\n- Output should be a clean, structured prompt spec:\n  Task:\n  Context (compressed):\n  Constraints:\n  Output format:\n- Remove duplication and boilerplate.\n- If level is aggressive and the context is long, summarize while preserving key details.\n- The optimized_prompt must be a plain string (not JSON).`;

const STRICT_RETRY_SYSTEM = `${BASE_SYSTEM}\n\nCRITICAL: Respond with JSON only. No prose. No code fences.`;

function buildUserPrompt(redactedText: string, options: OptimizeOptions): string {
  const fixLine = options.fixIssues?.length
    ? `\nFix these issues: ${options.fixIssues.join("; ")}.`
    : "";
  const preserveLine = options.preserveConstraints?.length
    ? `\nPreserve these constraints verbatim: ${options.preserveConstraints.join("; ")}.`
    : "";

  return `Optimization level: ${options.level}.\n${fixLine}${preserveLine}\nRedacted prompt:\n${redactedText}`.trim();
}

function extractJson(text: string): LLMOptimizeOutput | null {
  if (!text) return null;
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.optimized_prompt !== "string") return null;
    parsed.notes = Array.isArray(parsed.notes) ? parsed.notes.map(String) : [];
    parsed.preserved_constraints = Array.isArray(parsed.preserved_constraints)
      ? parsed.preserved_constraints.map(String)
      : [];
    parsed.dropped_constraints = Array.isArray(parsed.dropped_constraints)
      ? parsed.dropped_constraints.map(String)
      : [];
    if (parsed.level !== "light" && parsed.level !== "aggressive") return null;
    return parsed as LLMOptimizeOutput;
  } catch {
    return null;
  }
}

async function runOptimize(
  env: { AI: any },
  redactedText: string,
  options: OptimizeOptions,
  retry = false
) {
  const messages: LLMMessage[] = [
    { role: "system", content: retry ? STRICT_RETRY_SYSTEM : BASE_SYSTEM },
    { role: "user", content: buildUserPrompt(redactedText, options) },
  ];

  const result = await callLLM(env, {
    model: options.model ?? DEFAULT_MODEL,
    messages,
    maxTokens: 700,
    temperature: 0.2,
  });

  return { text: result.text?.trim() || "", usage: result.usage };
}

export async function llmOptimizePrompt(
  env: { AI: any },
  redactedText: string,
  options: OptimizeOptions
): Promise<{ output: LLMOptimizeOutput | null; raw: string; usage: { input_tokens?: number; output_tokens?: number } | null }> {
  const first = await runOptimize(env, redactedText, options, false);
  const parsedFirst = extractJson(first.text);
  if (parsedFirst) {
    return { output: parsedFirst, raw: first.text, usage: first.usage };
  }

  const second = await runOptimize(env, redactedText, options, true);
  const parsedSecond = extractJson(second.text);
  return { output: parsedSecond, raw: second.text, usage: second.usage };
}
