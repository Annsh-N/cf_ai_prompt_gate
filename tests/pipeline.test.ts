import { describe, expect, it } from "vitest";
import { compilePromptPipeline, type CacheStore } from "../src/lib/compilePipeline";
import { DEFAULT_SETTINGS, defaultUsage } from "../src/lib/settings";
import type { CacheEntry, UserSettings } from "../src/lib/types";

function mapCache(): CacheStore & { entries: Map<string, CacheEntry> } {
  const entries = new Map<string, CacheEntry>();
  return {
    entries,
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, entry) {
      entries.set(key, entry);
    },
  };
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function fakeAI(options: { leakSecret?: boolean; throwOnCall?: boolean; invalidFirst?: boolean } = {}) {
  const calls: Array<{ model: string; payload: any }> = [];
  let count = 0;
  return {
    calls,
    env: {
      AI: {
        async run(model: string, payload: any) {
          calls.push({ model, payload });
          count += 1;
          if (options.throwOnCall) throw new Error("mock unavailable");
          const system = payload.messages?.[0]?.content ?? "";
          if (options.invalidFirst && count === 1) {
            return { response: "not json", usage: { input_tokens: 9, output_tokens: 1 } };
          }
          if (/prompt quality checker/i.test(system)) {
            return {
              response: JSON.stringify({
                meaning_preserved: true,
                issues: [],
                missing_constraints: [],
                risk: "low",
              }),
              usage: { input_tokens: 8, output_tokens: 4 },
            };
          }
          return {
            response: JSON.stringify({
              optimized_prompt: options.leakSecret
                ? "Task: summarize\npassword=SuperSecretPass123!"
                : "Task: summarize the incident. Constraints: JSON output.",
              notes: ["removed repeated text"],
              preserved_constraints: ["JSON output"],
              dropped_constraints: [],
              level: "light",
            }),
            usage: { input_tokens: 10, output_tokens: 6 },
          };
        },
      },
    },
  };
}

describe("compilePromptPipeline", () => {
  it("never sends raw secrets to mocked AI when protection is enabled", async () => {
    const ai = fakeAI();
    const result = await compilePromptPipeline({
      env: ai.env,
      text: "Email jane@example.com and use api_key=SuperSecretPass123!",
      settings: settings(),
      usage: defaultUsage(),
      cache: mapCache(),
    });

    expect(result.status).toBe(200);
    const sent = JSON.stringify(ai.calls.flatMap((call) => call.payload.messages));
    expect(sent).not.toContain("jane@example.com");
    expect(sent).not.toContain("SuperSecretPass123");
    expect(sent).toContain("[EMAIL_1]");
    expect(result.body.report.redactionReport.totalRedactions).toBeGreaterThanOrEqual(2);
  });

  it("uses cache hits to avoid repeated AI calls", async () => {
    const ai = fakeAI();
    const cache = mapCache();
    const usage = defaultUsage();
    const first = await compilePromptPipeline({
      env: ai.env,
      text: "Return JSON. Return JSON. api_key=SuperSecretPass123!",
      settings: settings(),
      usage,
      cache,
    });
    const callsAfterFirst = ai.calls.length;
    const second = await compilePromptPipeline({
      env: ai.env,
      text: "Return JSON. Return JSON. api_key=SuperSecretPass123!",
      settings: settings(),
      usage: first.usage,
      cache,
    });

    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(ai.calls.length).toBe(callsAfterFirst);
    expect(second.body.report.cache.hit).toBe(true);
  });

  it("returns 402 before AI calls when estimated usage exceeds daily budget", async () => {
    const ai = fakeAI();
    const result = await compilePromptPipeline({
      env: ai.env,
      text: "api_key=SuperSecretPass123!",
      settings: settings({ dailyBudget: 1 }),
      usage: defaultUsage(),
      cache: mapCache(),
    });

    expect(result.status).toBe(402);
    expect(result.body.code).toBe("daily_budget_exceeded");
    expect(ai.calls).toHaveLength(0);
  });

  it("returns 429 when the per-minute request budget is exhausted", async () => {
    const ai = fakeAI();
    const usage = defaultUsage();
    usage.rpmWindowStart = Date.now();
    usage.rpmCount = 1;
    const result = await compilePromptPipeline({
      env: ai.env,
      text: "hello",
      settings: settings({ rpmLimit: 1 }),
      usage,
      cache: mapCache(),
    });

    expect(result.status).toBe(429);
    expect(result.body.code).toBe("rate_limit_exceeded");
    expect(ai.calls).toHaveLength(0);
  });

  it("falls back to deterministic output on AI errors", async () => {
    const ai = fakeAI({ throwOnCall: true });
    const result = await compilePromptPipeline({
      env: ai.env,
      text: "Repeat. Repeat. api_key=SuperSecretPass123!",
      settings: settings(),
      usage: defaultUsage(),
      cache: mapCache(),
    });

    expect(result.status).toBe(200);
    expect(result.body.error).toContain("Workers AI error");
    expect(result.body.report.checks.optimizationFailed).toBe(true);
    expect(result.body.compiledPrompt).toContain("[SECRET_1]");
  });

  it("retries invalid optimizer JSON and still returns optimized output", async () => {
    const ai = fakeAI({ invalidFirst: true });
    const result = await compilePromptPipeline({
      env: ai.env,
      text: "Return JSON. api_key=SuperSecretPass123!",
      settings: settings(),
      usage: defaultUsage(),
      cache: mapCache(),
    });

    expect(result.status).toBe(200);
    expect(ai.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.body.report.optimization.llmUsed).toBe(true);
  });

  it("post-redacts secret-like output returned by the LLM", async () => {
    const ai = fakeAI({ leakSecret: true });
    const result = await compilePromptPipeline({
      env: ai.env,
      text: "Summarize this. api_key=OriginalSecret123!",
      settings: settings(),
      usage: defaultUsage(),
      cache: mapCache(),
    });

    expect(result.status).toBe(200);
    expect(result.body.compiledPrompt).not.toContain("SuperSecretPass123");
    expect(result.body.report.checks.post_redaction_applied).toBe(true);
  });
});

