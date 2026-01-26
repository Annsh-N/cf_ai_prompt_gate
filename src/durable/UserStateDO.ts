import { redactSecrets } from "../lib/redaction";
import { llmOptimizePrompt, type OptimizationLevel } from "../lib/llmOptimize";
import { llmCheckMeaning, type MeaningCheckResult } from "../lib/llmCheck";
import { checkConstraints } from "../lib/constraintCheck";
import { deterministicOptimize } from "../lib/deterministicOptimize";
import { normalizeForOptimization } from "../lib/normalize";
import { estimateTokens } from "../lib/tokenEstimate";
import { sha256Hex } from "../lib/hash";
import { DEFAULT_MODEL } from "../lib/llm";

const DEFAULT_SETTINGS = {
  secretsProtection: true,
  strictMode: false,
  optimize: true,
  optimizeLevel: "light" as OptimizationLevel,
  checksEnabled: true,
  dailyBudget: 20000,
  rpmLimit: 20,
  cacheTtlSeconds: 60 * 60 * 24,
  historyMax: 10,
};

const COST_PER_1M_INPUT_TOKENS_USD = 0.3;
const OPTIMIZE_MAX_TOKENS = 700;
const CHECK_MAX_TOKENS = 400;

type UserSettings = typeof DEFAULT_SETTINGS;

type UsageState = {
  dailyDate: string;
  dailyUsed: number;
  rpmWindowStart: number;
  rpmCount: number;
};

type CacheEntry = {
  compiledPrompt: string;
  report: {
    optimization: { enabled: boolean; level: OptimizationLevel | "off"; llmUsed: boolean; notes: string[] };
    checks: {
      enabled: boolean;
      constraintCheck: { passed: boolean; missing: string[] };
      meaningCheck: { passed: boolean; risk: "low" | "medium" | "high"; issues: string[] };
      regenerations: number;
      optimizationFailed: boolean;
      post_redaction_applied: boolean;
    };
  };
  createdAt: number;
  ttlSeconds: number;
};

type HistoryEntry = {
  id: string;
  redactedHash: string;
  compiledPrompt: string;
  timestamp: number;
  report: {
    tokens: {
      original_est: number;
      compiled_est: number;
      saved: number;
      saved_pct: number;
    };
    cost: {
      original_est_usd: number;
      compiled_est_usd: number;
      saved_usd: number;
      saved_pct: number;
    };
    cache: { hit: boolean; key_short: string | null };
  };
};

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function clampNumber(value: unknown, fallback: number, min = 0, max = 1000000) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeSettings(base: UserSettings, override?: Partial<UserSettings>): UserSettings {
  if (!override) return base;
  return {
    secretsProtection: clampBoolean(override.secretsProtection, base.secretsProtection),
    strictMode: clampBoolean(override.strictMode, base.strictMode),
    optimize: clampBoolean(override.optimize, base.optimize),
    optimizeLevel:
      override.optimizeLevel === "aggressive" || override.optimizeLevel === "light"
        ? override.optimizeLevel
        : base.optimizeLevel ?? "light",
    checksEnabled: clampBoolean(override.checksEnabled, base.checksEnabled),
    dailyBudget: clampNumber(override.dailyBudget, base.dailyBudget, 1000, 200000),
    rpmLimit: clampNumber(override.rpmLimit, base.rpmLimit, 1, 600),
    cacheTtlSeconds: clampNumber(
      override.cacheTtlSeconds,
      base.cacheTtlSeconds,
      60,
      7 * 24 * 60 * 60
    ),
    historyMax: clampNumber(override.historyMax, base.historyMax, 0, 50),
  };
}

function costFromTokens(tokens: number): number {
  const cost = (tokens * COST_PER_1M_INPUT_TOKENS_USD) / 1_000_000;
  return Number(cost.toFixed(6));
}

function estimateCallTokens(inputText: string, maxTokens: number): number {
  return estimateTokens(inputText) + maxTokens;
}

function buildTokenReport(original: string, compiled: string) {
  const originalTokens = estimateTokens(original);
  const compiledTokens = estimateTokens(compiled);
  const savedTokens = Math.max(0, originalTokens - compiledTokens);
  const savedPct = originalTokens
    ? Math.round((savedTokens / originalTokens) * 100)
    : 0;
  return {
    original_est: originalTokens,
    compiled_est: compiledTokens,
    saved: savedTokens,
    saved_pct: savedPct,
  };
}

function buildCostReport(tokens: ReturnType<typeof buildTokenReport>) {
  const originalCost = costFromTokens(tokens.original_est);
  const compiledCost = costFromTokens(tokens.compiled_est);
  const savedCost = Number((originalCost - compiledCost).toFixed(6));
  const savedCostPct = originalCost ? Math.round((savedCost / originalCost) * 100) : 0;
  return {
    per_1m_input_tokens_usd: COST_PER_1M_INPUT_TOKENS_USD,
    original_est_usd: originalCost,
    compiled_est_usd: compiledCost,
    saved_usd: savedCost,
    saved_pct: savedCostPct,
  };
}

function formatLLMError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication error|inferenceupstreamerror|10000/i.test(message)) {
    return "Workers AI authentication error. Check your Cloudflare auth and AI binding.";
  }
  return `Workers AI error: ${message}`;
}

export class UserStateDO {
  state: DurableObjectState;
  env: { AI: any };

  constructor(state: DurableObjectState, env: { AI: any }) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if ((url.pathname === "/api/compile" || url.pathname === "/api/chat") && request.method === "POST") {
      return this.handleCompile(request);
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      return this.handleGetState();
    }

    if (url.pathname === "/api/state" && request.method === "POST") {
      return this.handleUpdateState(request);
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      return this.handleHistory();
    }

    if (url.pathname === "/api/clear-history" && request.method === "POST") {
      return this.handleClearHistory();
    }

    return new Response("Not found", { status: 404 });
  }

  private async getSettings(): Promise<UserSettings> {
    const stored = await this.state.storage.get<UserSettings>("settings");
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  private async saveSettings(settings: UserSettings) {
    await this.state.storage.put("settings", settings);
  }

  private async getUsage(): Promise<UsageState> {
    const stored = await this.state.storage.get<UsageState>("usage");
    const today = todayUTC();
    if (!stored) {
      const fresh = {
        dailyDate: today,
        dailyUsed: 0,
        rpmWindowStart: 0,
        rpmCount: 0,
      };
      await this.state.storage.put("usage", fresh);
      return fresh;
    }
    if (stored.dailyDate !== today) {
      const reset = {
        ...stored,
        dailyDate: today,
        dailyUsed: 0,
        rpmWindowStart: 0,
        rpmCount: 0,
      };
      await this.state.storage.put("usage", reset);
      return reset;
    }
    return stored;
  }

  private async saveUsage(usage: UsageState) {
    await this.state.storage.put("usage", usage);
  }

  private async getCache(key: string): Promise<CacheEntry | null> {
    const stored = await this.state.storage.get<CacheEntry>(`cache:${key}`);
    if (!stored) return null;
    const expiresAt = stored.createdAt + stored.ttlSeconds * 1000;
    if (Date.now() > expiresAt) {
      await this.state.storage.delete(`cache:${key}`);
      return null;
    }
    return stored;
  }

  private async setCache(key: string, entry: CacheEntry) {
    await this.state.storage.put(`cache:${key}`, entry);
  }

  private async getHistory(): Promise<HistoryEntry[]> {
    const stored = await this.state.storage.get<HistoryEntry[]>("history");
    return Array.isArray(stored) ? stored : [];
  }

  private async saveHistory(entries: HistoryEntry[]) {
    await this.state.storage.put("history", entries);
  }

  private async appendHistory(entry: HistoryEntry, settings: UserSettings) {
    const entries = await this.getHistory();
    entries.unshift(entry);
    if (entries.length > settings.historyMax) {
      entries.splice(settings.historyMax);
    }
    await this.saveHistory(entries);
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "content-type": "application/json",
      },
    });
  }

  private async handleGetState(): Promise<Response> {
    const settings = await this.getSettings();
    const usage = await this.getUsage();
    const remaining = Math.max(0, settings.dailyBudget - usage.dailyUsed);
    const history = await this.getHistory();

    return this.json({
      settings,
      usage: {
        daily_budget_tokens: settings.dailyBudget,
        daily_used_tokens: usage.dailyUsed,
        daily_remaining_tokens: remaining,
        rpm_limit: settings.rpmLimit,
        rpm_used: usage.rpmCount,
      },
      history: {
        count: history.length,
        max: settings.historyMax,
      },
    });
  }

  private async handleUpdateState(request: Request): Promise<Response> {
    let body: any = null;
    try {
      body = await request.json();
    } catch {
      return this.json({ error: "Invalid JSON" }, 400);
    }

    const current = await this.getSettings();
    const updated = normalizeSettings(current, body?.settings ?? body);
    await this.saveSettings(updated);

    return this.json({ settings: updated });
  }

  private async handleHistory(): Promise<Response> {
    const entries = await this.getHistory();
    return this.json({ entries });
  }

  private async handleClearHistory(): Promise<Response> {
    await this.saveHistory([]);
    return this.json({ ok: true });
  }

  private async handleCompile(request: Request): Promise<Response> {
    const requestStart = Date.now();
    let body: any = null;
    try {
      body = await request.json();
    } catch {
      return this.json({ error: "Invalid JSON" }, 400);
    }

    const text = typeof body?.text === "string" ? body.text : typeof body?.message === "string" ? body.message : "";
    const settingsOverride = body?.settingsOverride ?? body?.settings;

    const storedSettings = await this.getSettings();
    const requestedSettings = normalizeSettings(storedSettings, settingsOverride);
    const usage = await this.getUsage();

    const now = Date.now();
    if (now - usage.rpmWindowStart >= 60_000) {
      usage.rpmWindowStart = now;
      usage.rpmCount = 0;
    }

    if (usage.rpmCount >= requestedSettings.rpmLimit) {
      const tokensReport = buildTokenReport(text, "");
      return this.json(
        {
          originalText: text,
          compiledPrompt: "",
          report: {
            tokens: tokensReport,
            cost: buildCostReport(tokensReport),
            redactionReport: {
              enabled: requestedSettings.secretsProtection,
              strict: requestedSettings.strictMode,
              totalRedactions: 0,
              items: [],
              strictApplied: false,
            },
            normalization: { removedDuplicateLines: 0, removedDuplicateSentences: 0 },
            optimization: {
              enabled: requestedSettings.optimize,
              level: requestedSettings.optimize ? requestedSettings.optimizeLevel : "off",
              llmUsed: false,
              notes: [],
            },
            checks: {
              enabled: requestedSettings.checksEnabled,
              constraintCheck: { passed: true, missing: [] },
              meaningCheck: { passed: true, risk: "low", issues: [] },
              regenerations: 0,
              optimizationFailed: false,
              post_redaction_applied: false,
            },
            cache: { hit: false, key_short: null },
            timing_ms: {
              redaction: 0,
              normalization: 0,
              optimize_llm: 0,
              check_llm: 0,
              total: Date.now() - requestStart,
            },
            usage: {
              daily_budget_tokens: requestedSettings.dailyBudget,
              daily_used_tokens: usage.dailyUsed,
              daily_remaining_tokens: Math.max(0, requestedSettings.dailyBudget - usage.dailyUsed),
              rpm_limit: requestedSettings.rpmLimit,
              rpm_used: usage.rpmCount,
            },
          },
          error: "Rate limit exceeded",
        },
        429
      );
    }

    usage.rpmCount += 1;
    await this.saveUsage(usage);

    const redactionStart = Date.now();
    let redactedText = text;
    let redactionReport = {
      enabled: requestedSettings.secretsProtection,
      strict: requestedSettings.strictMode,
      totalRedactions: 0,
      items: [] as Array<{ type: string; count: number; previews: string[] }>,
      strictApplied: false,
    };

    if (requestedSettings.secretsProtection) {
      const redaction = redactSecrets(text, requestedSettings.strictMode);
      redactedText = redaction.redactedText;
      redactionReport = {
        ...redaction.report,
        enabled: requestedSettings.secretsProtection,
      };
    }

    const redactionMs = Date.now() - redactionStart;

    const normalizationStart = Date.now();
    const normalization = normalizeForOptimization(redactedText);
    let normalizedText = normalization.text;
    const normalizationMs = Date.now() - normalizationStart;

    let compiledPrompt = normalizedText;
    let optimizationNotes: string[] = [];
    let optimizationFailed = false;
    let llmUsed = false;
    let regenerateCount = 0;
    let optimizeMs = 0;
    let checkMs = 0;
    let cacheHit = false;
    let cacheKeyShort: string | null = null;
    let llmError: string | null = null;

    const constraintCheckResult = checkConstraints(redactedText, compiledPrompt);
    let meaningCheckResult: MeaningCheckResult = {
      meaning_preserved: true,
      issues: [],
      missing_constraints: [],
      risk: "low",
    };

    const canUseLLM = requestedSettings.secretsProtection && requestedSettings.optimize;
    let checksEnabled = requestedSettings.secretsProtection && requestedSettings.checksEnabled;
    let cacheKey: string | null = null;
    let shouldCache = false;

    if (requestedSettings.optimize && canUseLLM) {
      cacheKey = await sha256Hex(
        JSON.stringify({
          prompt: normalizedText,
          level: requestedSettings.optimizeLevel,
          strictMode: requestedSettings.strictMode,
          model: DEFAULT_MODEL,
          checks: checksEnabled,
        })
      );
      cacheKeyShort = cacheKey.slice(0, 8);

      const cached = await this.getCache(cacheKey);
      if (cached) {
        compiledPrompt = cached.compiledPrompt;
        optimizationNotes = cached.report.optimization.notes;
        llmUsed = cached.report.optimization.llmUsed;
        optimizationFailed = cached.report.checks.optimizationFailed;
        regenerateCount = cached.report.checks.regenerations;
        checksEnabled = cached.report.checks.enabled;
        cacheHit = true;
        constraintCheckResult.passed = cached.report.checks.constraintCheck.passed;
        constraintCheckResult.missing = cached.report.checks.constraintCheck.missing;
        meaningCheckResult = {
          meaning_preserved: cached.report.checks.meaningCheck.passed,
          issues: cached.report.checks.meaningCheck.issues,
          missing_constraints: cached.report.checks.constraintCheck.missing,
          risk: cached.report.checks.meaningCheck.risk,
        };
      } else {
        shouldCache = true;
        const estimatedOptTokens = estimateCallTokens(normalizedText, OPTIMIZE_MAX_TOKENS);
        if (usage.dailyUsed + estimatedOptTokens > requestedSettings.dailyBudget) {
          const tokensReport = buildTokenReport(text, "");
          return this.json(
            {
              originalText: text,
              compiledPrompt: "",
              report: {
                tokens: tokensReport,
                cost: buildCostReport(tokensReport),
                redactionReport,
                normalization: {
                  removedDuplicateLines: normalization.removedDuplicateLines,
                  removedDuplicateSentences: normalization.removedDuplicateSentences,
                },
                optimization: {
                  enabled: requestedSettings.optimize,
                  level: requestedSettings.optimizeLevel,
                  llmUsed: false,
                  notes: [],
                },
                checks: {
                  enabled: checksEnabled,
                  constraintCheck: { passed: true, missing: [] },
                  meaningCheck: { passed: true, risk: "low", issues: [] },
                  regenerations: 0,
                  optimizationFailed: false,
                  post_redaction_applied: false,
                },
                cache: { hit: false, key_short: cacheKeyShort },
                timing_ms: {
                  redaction: redactionMs,
                  normalization: normalizationMs,
                  optimize_llm: 0,
                  check_llm: 0,
                  total: Date.now() - requestStart,
                },
                usage: {
                  daily_budget_tokens: requestedSettings.dailyBudget,
                  daily_used_tokens: usage.dailyUsed,
                  daily_remaining_tokens: Math.max(0, requestedSettings.dailyBudget - usage.dailyUsed),
                  rpm_limit: requestedSettings.rpmLimit,
                  rpm_used: usage.rpmCount,
                },
              },
              error: "Daily token budget exceeded",
            },
            402
          );
        }

        let optResult: Awaited<ReturnType<typeof llmOptimizePrompt>> | null = null;
        try {
          const optStart = Date.now();
          optResult = await llmOptimizePrompt(this.env, normalizedText, {
            level: requestedSettings.optimizeLevel,
            model: DEFAULT_MODEL,
          });
          optimizeMs += Date.now() - optStart;
        } catch (error) {
          llmError = formatLLMError(error);
          optimizationFailed = true;
          compiledPrompt = normalizedText;
          checksEnabled = false;
          shouldCache = false;
          cacheKey = null;
          cacheKeyShort = null;
        }

        if (!llmError && optResult) {
          if (optResult.output) {
            compiledPrompt = optResult.output.optimized_prompt.trim() || normalizedText;
            optimizationNotes = optResult.output.notes ?? [];
            llmUsed = true;
          } else {
            optimizationFailed = true;
            compiledPrompt = normalizedText;
          }

          const optUsageTokens =
            (optResult.usage?.input_tokens ?? estimateTokens(normalizedText)) +
            (optResult.usage?.output_tokens ?? OPTIMIZE_MAX_TOKENS);
          usage.dailyUsed += optUsageTokens;
          await this.saveUsage(usage);

          let constraintCheck = checkConstraints(redactedText, compiledPrompt);
          let meaningCheck: MeaningCheckResult = meaningCheckResult;

          if (checksEnabled) {
            const estimatedCheckTokens = estimateCallTokens(
              `${redactedText}\n${compiledPrompt}`,
              CHECK_MAX_TOKENS
            );
            if (usage.dailyUsed + estimatedCheckTokens > requestedSettings.dailyBudget) {
              checksEnabled = false;
              shouldCache = false;
              cacheKey = null;
              cacheKeyShort = null;
            } else {
              try {
                const checkStart = Date.now();
                const checkResult = await llmCheckMeaning(this.env, redactedText, compiledPrompt);
                checkMs += Date.now() - checkStart;
                if (checkResult.output) {
                  meaningCheck = checkResult.output;
                }
                const checkUsageTokens =
                  (checkResult.usage?.input_tokens ?? estimateTokens(`${redactedText}\n${compiledPrompt}`)) +
                  (checkResult.usage?.output_tokens ?? CHECK_MAX_TOKENS);
                usage.dailyUsed += checkUsageTokens;
                await this.saveUsage(usage);
              } catch (error) {
                llmError = formatLLMError(error);
                checksEnabled = false;
                shouldCache = false;
                cacheKey = null;
                cacheKeyShort = null;
              }
            }
          }

          const needsRegenerate =
            (checksEnabled && (!meaningCheck.meaning_preserved || meaningCheck.risk === "high")) ||
            (checksEnabled && constraintCheck.missing.length > 0);

          if (needsRegenerate && checksEnabled) {
            const fixIssues = [
              ...meaningCheck.issues,
              ...meaningCheck.missing_constraints,
              ...constraintCheck.missing,
            ].filter(Boolean);

            const estimatedRegenTokens = estimateCallTokens(normalizedText, OPTIMIZE_MAX_TOKENS);
            if (usage.dailyUsed + estimatedRegenTokens <= requestedSettings.dailyBudget) {
              try {
                const regenStart = Date.now();
                const regenResult = await llmOptimizePrompt(this.env, normalizedText, {
                  level: requestedSettings.optimizeLevel,
                  model: DEFAULT_MODEL,
                  fixIssues,
                  preserveConstraints: constraintCheck.constraints,
                });
                optimizeMs += Date.now() - regenStart;
                regenerateCount += 1;

                if (regenResult.output) {
                  compiledPrompt = regenResult.output.optimized_prompt.trim() || compiledPrompt;
                  optimizationNotes = regenResult.output.notes ?? optimizationNotes;
                  llmUsed = true;
                }

                const regenUsageTokens =
                  (regenResult.usage?.input_tokens ?? estimateTokens(normalizedText)) +
                  (regenResult.usage?.output_tokens ?? OPTIMIZE_MAX_TOKENS);
                usage.dailyUsed += regenUsageTokens;
                await this.saveUsage(usage);

                constraintCheck = checkConstraints(redactedText, compiledPrompt);
                if (checksEnabled) {
                  const checkStart = Date.now();
                  const checkResult = await llmCheckMeaning(this.env, redactedText, compiledPrompt);
                  checkMs += Date.now() - checkStart;
                  if (checkResult.output) meaningCheck = checkResult.output;
                  const checkUsageTokens =
                    (checkResult.usage?.input_tokens ?? estimateTokens(`${redactedText}\n${compiledPrompt}`)) +
                    (checkResult.usage?.output_tokens ?? CHECK_MAX_TOKENS);
                  usage.dailyUsed += checkUsageTokens;
                  await this.saveUsage(usage);
                }
              } catch (error) {
                llmError = formatLLMError(error);
                checksEnabled = false;
                shouldCache = false;
                cacheKey = null;
                cacheKeyShort = null;
              }
            } else {
              optimizationFailed = true;
            }
          }

          constraintCheckResult.passed = constraintCheck.passed;
          constraintCheckResult.missing = constraintCheck.missing;
          constraintCheckResult.constraints = constraintCheck.constraints;
          meaningCheckResult = meaningCheck;

          if (
            (checksEnabled && (!meaningCheck.meaning_preserved || meaningCheck.risk === "high")) ||
            (checksEnabled && constraintCheck.missing.length > 0)
          ) {
            optimizationFailed = true;
            compiledPrompt = normalizedText;
          }
        }
      }
    } else if (requestedSettings.optimize) {
      compiledPrompt = deterministicOptimize(normalizedText, requestedSettings.optimizeLevel);
      const constraintCheck = checkConstraints(redactedText, compiledPrompt);
      constraintCheckResult.passed = constraintCheck.passed;
      constraintCheckResult.missing = constraintCheck.missing;
      constraintCheckResult.constraints = constraintCheck.constraints;
    }

    const postNormalize = normalizeForOptimization(compiledPrompt);
    compiledPrompt = postNormalize.text;

    const postRedaction = redactSecrets(compiledPrompt, requestedSettings.strictMode);
    let postRedactionApplied = false;
    if (postRedaction.redactedText !== compiledPrompt) {
      compiledPrompt = postRedaction.redactedText;
      postRedactionApplied = true;
    }

    if (shouldCache && cacheKey) {
      const cacheEntry: CacheEntry = {
        compiledPrompt,
        report: {
          optimization: {
            enabled: requestedSettings.optimize,
            level: requestedSettings.optimizeLevel,
            llmUsed,
            notes: optimizationNotes,
          },
          checks: {
            enabled: checksEnabled,
            constraintCheck: {
              passed: constraintCheckResult.passed,
              missing: constraintCheckResult.missing,
            },
            meaningCheck: {
              passed: meaningCheckResult.meaning_preserved,
              risk: meaningCheckResult.risk,
              issues: meaningCheckResult.issues,
            },
            regenerations: regenerateCount,
            optimizationFailed,
            post_redaction_applied: postRedactionApplied,
          },
        },
        createdAt: Date.now(),
        ttlSeconds: requestedSettings.cacheTtlSeconds,
      };

      await this.setCache(cacheKey, cacheEntry);
    }

    const tokensReport = buildTokenReport(text, compiledPrompt);
    const costReport = buildCostReport(tokensReport);

    const report = {
      tokens: tokensReport,
      cost: costReport,
      redactionReport,
      normalization: {
        removedDuplicateLines: normalization.removedDuplicateLines,
        removedDuplicateSentences: normalization.removedDuplicateSentences,
      },
      optimization: {
        enabled: requestedSettings.optimize,
        level: requestedSettings.optimize ? requestedSettings.optimizeLevel : "off",
        llmUsed: llmUsed,
        notes: optimizationNotes,
      },
      checks: {
        enabled: checksEnabled,
        constraintCheck: {
          passed: constraintCheckResult.passed,
          missing: constraintCheckResult.missing,
        },
        meaningCheck: {
          passed: meaningCheckResult.meaning_preserved,
          risk: meaningCheckResult.risk,
          issues: meaningCheckResult.issues,
        },
        regenerations: regenerateCount,
        optimizationFailed,
        post_redaction_applied: postRedactionApplied,
      },
      cache: { hit: cacheHit, key_short: cacheKeyShort },
      timing_ms: {
        redaction: redactionMs,
        normalization: normalizationMs,
        optimize_llm: optimizeMs,
        check_llm: checkMs,
        total: Date.now() - requestStart,
      },
      usage: {
        daily_budget_tokens: requestedSettings.dailyBudget,
        daily_used_tokens: usage.dailyUsed,
        daily_remaining_tokens: Math.max(0, requestedSettings.dailyBudget - usage.dailyUsed),
        rpm_limit: requestedSettings.rpmLimit,
        rpm_used: usage.rpmCount,
      },
    };

    const historyEntry: HistoryEntry = {
      id: crypto.randomUUID(),
      redactedHash: await sha256Hex(redactedText),
      compiledPrompt,
      timestamp: Date.now(),
      report: {
        tokens: tokensReport,
        cost: {
          original_est_usd: costReport.original_est_usd,
          compiled_est_usd: costReport.compiled_est_usd,
          saved_usd: costReport.saved_usd,
          saved_pct: costReport.saved_pct,
        },
        cache: { hit: cacheHit, key_short: cacheKeyShort },
      },
    };

    await this.appendHistory(historyEntry, requestedSettings);

    return this.json({
      originalText: text,
      compiledPrompt,
      report,
      error: llmError,
    });
  }
}
