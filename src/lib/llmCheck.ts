import { callLLM, DEFAULT_MODEL, type LLMMessage } from "./llm";

export type MeaningCheckResult = {
  meaning_preserved: boolean;
  issues: string[];
  missing_constraints: string[];
  risk: "low" | "medium" | "high";
};

const CHECK_SYSTEM = `You are a prompt quality checker. You MUST return STRICT JSON only with no extra text.\n\nOutput schema:\n{\n  "meaning_preserved": true|false,\n  "issues": ["string"],\n  "missing_constraints": ["string"],\n  "risk": "low"|"medium"|"high"\n}\n\nRules:\n- Compare the redacted original prompt with the compiled prompt.\n- Identify any changes in intent, missing constraints, or altered requirements.\n- If meaning is not preserved, set meaning_preserved to false and risk to high.\n- Be concise.`;

const STRICT_RETRY_SYSTEM = `${CHECK_SYSTEM}\n\nCRITICAL: Respond with JSON only. No prose. No code fences.`;

function extractJson(text: string): MeaningCheckResult | null {
  if (!text) return null;
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.meaning_preserved !== "boolean") return null;
    parsed.issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
    parsed.missing_constraints = Array.isArray(parsed.missing_constraints)
      ? parsed.missing_constraints.map(String)
      : [];
    if (parsed.risk !== "low" && parsed.risk !== "medium" && parsed.risk !== "high") {
      return null;
    }
    return parsed as MeaningCheckResult;
  } catch {
    return null;
  }
}

async function runCheck(
  env: { AI: any },
  redactedText: string,
  optimizedPrompt: string,
  retry = false
) {
  const messages: LLMMessage[] = [
    { role: "system", content: retry ? STRICT_RETRY_SYSTEM : CHECK_SYSTEM },
    {
      role: "user",
      content: `Redacted original:\n${redactedText}\n\nCompiled prompt:\n${optimizedPrompt}`,
    },
  ];

  const result = await callLLM(env, {
    model: DEFAULT_MODEL,
    messages,
    maxTokens: 400,
    temperature: 0,
  });

  return { text: result.text?.trim() || "", usage: result.usage };
}

export async function llmCheckMeaning(
  env: { AI: any },
  redactedText: string,
  optimizedPrompt: string
): Promise<{ output: MeaningCheckResult | null; raw: string; usage: { input_tokens?: number; output_tokens?: number } | null }> {
  const first = await runCheck(env, redactedText, optimizedPrompt, false);
  const parsedFirst = extractJson(first.text);
  if (parsedFirst) {
    return { output: parsedFirst, raw: first.text, usage: first.usage };
  }

  const second = await runCheck(env, redactedText, optimizedPrompt, true);
  const parsedSecond = extractJson(second.text);
  return { output: parsedSecond, raw: second.text, usage: second.usage };
}
