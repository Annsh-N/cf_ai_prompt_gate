import { describe, expect, it } from "vitest";
import { checkConstraints } from "../src/lib/constraintCheck";
import { parseMeaningCheckJson } from "../src/lib/llmCheck";
import { parseOptimizeJson } from "../src/lib/llmOptimize";
import { normalizeForOptimization } from "../src/lib/normalize";
import { buildCostReport, buildTokenReport } from "../src/lib/reports";
import { redactSecrets } from "../src/lib/redaction";
import { estimateTokens } from "../src/lib/tokenEstimate";

describe("redaction", () => {
  it("redacts common PII and secret patterns", () => {
    const input = [
      "email jane@example.com",
      "phone +1 (415) 555-1212",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMe",
      "openai sk-abcdefghijklmnopqrstuvwxyz123456",
      "github ghp_abcdefghijklmnopqrstuvwxyz123456",
      "slack xoxb-123456789012-abcdefabcdef",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    ].join("\n");

    const result = redactSecrets(input, false);

    expect(result.report.totalRedactions).toBeGreaterThanOrEqual(7);
    expect(result.redactedText).not.toContain("jane@example.com");
    expect(result.redactedText).not.toContain("555-1212");
    expect(result.redactedText).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.redactedText).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(result.redactedText).toContain("[EMAIL_1]");
    expect(result.redactedText).toContain("[PHONE_1]");
  });

  it("redacts strict high-entropy token candidates", () => {
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const result = redactSecrets(`token ${token}`, true);
    expect(result.report.strictApplied).toBe(true);
    expect(result.redactedText).not.toContain(token);
  });
});

describe("normalization and reports", () => {
  it("deduplicates lines and repeated sentences", () => {
    const result = normalizeForOptimization("Do this. Do this.\n\n\nKeep this\nKeep this");
    expect(result.text).toBe("Do this.\n\nKeep this");
    expect(result.removedDuplicateLines).toBeGreaterThan(0);
    expect(result.removedDuplicateSentences).toBe(1);
  });

  it("estimates tokens and costs consistently", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    const tokens = buildTokenReport("a".repeat(400), "a".repeat(200));
    expect(tokens.saved_pct).toBe(50);
    expect(buildCostReport(tokens).saved_pct).toBe(50);
  });
});

describe("constraint checks", () => {
  it("checks actual word counts for word limits", () => {
    expect(checkConstraints("Keep it under 3 words", "two words").passed).toBe(true);
    expect(checkConstraints("Keep it under 3 words", "one two three four").missing).toEqual([
      "at most 3 words",
    ]);
  });

  it("requires excluded phrases to be absent", () => {
    expect(checkConstraints("exclude banana", "apple pear").passed).toBe(true);
    expect(checkConstraints("exclude banana", "apple banana").missing).toEqual([
      "exclude banana",
    ]);
  });
});

describe("LLM JSON parsers", () => {
  it("extracts optimizer JSON from surrounding text", () => {
    const parsed = parseOptimizeJson(
      '```json\n{"optimized_prompt":"Task: test","notes":[],"preserved_constraints":[],"dropped_constraints":[],"level":"light"}\n```'
    );
    expect(parsed?.optimized_prompt).toBe("Task: test");
  });

  it("rejects malformed meaning-check JSON", () => {
    expect(parseMeaningCheckJson("{ nope")).toBeNull();
  });
});
