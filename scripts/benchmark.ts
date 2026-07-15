import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { compilePromptPipeline, type CacheStore } from "../src/lib/compilePipeline";
import { DEFAULT_SETTINGS, defaultUsage } from "../src/lib/settings";
import type { CacheEntry, CompileResponseBody } from "../src/lib/types";

type CorpusCase = { name: string; text: string };

type RequestResult = {
  caseName: string;
  pass: "miss" | "hit";
  status: number;
  latencyMs: number;
  savedPct: number;
  redactions: number;
  cacheHit: boolean;
  aiCallsBefore: number;
  aiCallsAfter: number;
  leakedRawSecretToAI: boolean;
};

const SECRET_NEEDLES = [
  "jane@example.com",
  "555-1212",
  "example_token_9aB3cD4eF5gH6iJ7",
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "abcdefghijklmnopqrstuvwxyz123456",
  "SuperSecretPass123",
];

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(2));
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function createCache(): CacheStore {
  const entries = new Map<string, CacheEntry>();
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, entry) {
      entries.set(key, entry);
    },
  };
}

function compactPrompt(input: string): string {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase().replace(/[.!?]+$/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  return `Task:\n${kept.slice(0, 2).join("\n")}\n\nConstraints:\nPreserve explicit output, tone, and safety requirements.`;
}

function createMockAI() {
  const calls: Array<{ model: string; payload: any }> = [];
  return {
    calls,
    env: {
      AI: {
        async run(model: string, payload: any) {
          calls.push({ model, payload });
          const system = String(payload.messages?.[0]?.content ?? "");
          const user = String(payload.messages?.[1]?.content ?? "");
          if (/prompt quality checker/i.test(system)) {
            return {
              response: JSON.stringify({
                meaning_preserved: true,
                issues: [],
                missing_constraints: [],
                risk: "low",
              }),
              usage: { input_tokens: 42, output_tokens: 12 },
            };
          }
          return {
            response: JSON.stringify({
              optimized_prompt: compactPrompt(user),
              notes: ["mock benchmark compression"],
              preserved_constraints: ["safety", "format"],
              dropped_constraints: [],
              level: "light",
            }),
            usage: { input_tokens: 64, output_tokens: 24 },
          };
        },
      },
    },
  };
}

function didLeakRawSecret(calls: Array<{ payload: any }>, startIndex: number): boolean {
  const sent = JSON.stringify(calls.slice(startIndex).flatMap((call) => call.payload.messages ?? []));
  return SECRET_NEEDLES.some((needle) => sent.includes(needle));
}

async function runOne(
  corpusCase: CorpusCase,
  pass: "miss" | "hit",
  ai: ReturnType<typeof createMockAI>,
  cache: CacheStore,
  usage: ReturnType<typeof defaultUsage>
): Promise<{ result: RequestResult; body: CompileResponseBody; usage: ReturnType<typeof defaultUsage> }> {
  const callsBefore = ai.calls.length;
  const start = performance.now();
  const pipeline = await compilePromptPipeline({
    env: ai.env,
    text: corpusCase.text,
    settings: { ...DEFAULT_SETTINGS, dailyBudget: 200000, rpmLimit: 600 },
    usage,
    cache,
    randomId: () => `${corpusCase.name}-${pass}`,
  });
  const latencyMs = Number((performance.now() - start).toFixed(2));

  return {
    body: pipeline.body,
    usage: pipeline.usage,
    result: {
      caseName: corpusCase.name,
      pass,
      status: pipeline.status,
      latencyMs,
      savedPct: pipeline.body.report.tokens.saved_pct,
      redactions: pipeline.body.report.redactionReport.totalRedactions,
      cacheHit: pipeline.body.report.cache.hit,
      aiCallsBefore: callsBefore,
      aiCallsAfter: ai.calls.length,
      leakedRawSecretToAI: didLeakRawSecret(ai.calls, callsBefore),
    },
  };
}

async function main() {
  const corpus = JSON.parse(
    await readFile("benchmarks/corpus/prompts.json", "utf8")
  ) as CorpusCase[];
  const ai = createMockAI();
  const cache = createCache();
  let usage = defaultUsage();
  const requests: RequestResult[] = [];

  for (const item of corpus) {
    const miss = await runOne(item, "miss", ai, cache, usage);
    usage = miss.usage;
    requests.push(miss.result);

    const hit = await runOne(item, "hit", ai, cache, usage);
    usage = hit.usage;
    requests.push(hit.result);
  }

  const allLatencies = requests.map((item) => item.latencyMs);
  const hitLatencies = requests.filter((item) => item.cacheHit).map((item) => item.latencyMs);
  const missLatencies = requests.filter((item) => !item.cacheHit).map((item) => item.latencyMs);
  const failed = requests.filter((item) => item.status !== 200 || item.leakedRawSecretToAI);
  const uniqueRedactionCases = requests.filter((item) => item.redactions > 0).length;
  const aiCallsAvoided = requests
    .filter((item) => item.cacheHit)
    .reduce((sum, item) => sum + (item.aiCallsAfter === item.aiCallsBefore ? 2 : 0), 0);

  const summary = {
    measuredAt: new Date().toISOString(),
    mode: process.env.PROMPTGATE_LIVE_AI ? "live-ai" : "mock-ai",
    corpusSize: corpus.length,
    requests: requests.length,
    failedRequests: failed.length,
    aiCalls: ai.calls.length,
    aiCallsAvoidedByCache: aiCallsAvoided,
    averageTokenReductionPct: average(requests.map((item) => item.savedPct)),
    p50LatencyMs: percentile(allLatencies, 50),
    p95LatencyMs: percentile(allLatencies, 95),
    p50MissLatencyMs: percentile(missLatencies, 50),
    p95MissLatencyMs: percentile(missLatencies, 95),
    p50CacheHitLatencyMs: percentile(hitLatencies, 50),
    p95CacheHitLatencyMs: percentile(hitLatencies, 95),
    redactionPositiveRequests: uniqueRedactionCases,
    rawSecretLeaksToAI: requests.filter((item) => item.leakedRawSecretToAI).length,
    results: requests,
  };

  await mkdir("benchmarks/results", { recursive: true });
  await writeFile("benchmarks/results/latest.json", `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    "benchmarks/results/latest.md",
    [
      "# PromptGate Benchmark Results",
      "",
      `Measured at: ${summary.measuredAt}`,
      `Mode: ${summary.mode}`,
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      `| Corpus cases | ${summary.corpusSize} |`,
      `| Requests | ${summary.requests} |`,
      `| Failed requests | ${summary.failedRequests} |`,
      `| Average token reduction | ${summary.averageTokenReductionPct}% |`,
      `| p95 cache-hit latency | ${summary.p95CacheHitLatencyMs} ms |`,
      `| p95 miss latency | ${summary.p95MissLatencyMs} ms |`,
      `| AI calls avoided by cache | ${summary.aiCallsAvoidedByCache} |`,
      `| Raw secret leaks to AI | ${summary.rawSecretLeaksToAI} |`,
      `| Requests with redactions | ${summary.redactionPositiveRequests} |`,
      "",
    ].join("\n")
  );

  if (failed.length) {
    console.error(JSON.stringify({ failed }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

