import { checkConstraints } from "./constraintCheck";
import { deterministicOptimize } from "./deterministicOptimize";
import { sha256Hex } from "./hash";
import { DEFAULT_MODEL } from "./llm";
import { llmCheckMeaning, type MeaningCheckResult } from "./llmCheck";
import { llmOptimizePrompt } from "./llmOptimize";
import { normalizeForOptimization } from "./normalize";
import { redactSecrets } from "./redaction";
import { estimateTokens } from "./tokenEstimate";
import {
  buildCostReport,
  buildTokenReport,
  CHECK_MAX_TOKENS,
  estimateCallTokens,
  formatLLMError,
  OPTIMIZE_MAX_TOKENS,
  usageReport,
} from "./reports";
import type {
  CacheEntry,
  CompileReport,
  CompileResponseBody,
  HistoryEntry,
  UsageState,
  UserSettings,
} from "./types";

export type CacheStore = {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
};

export type CompilePipelineOptions = {
  env: { AI: any };
  text: string;
  settings: UserSettings;
  usage: UsageState;
  cache: CacheStore;
  now?: () => number;
  randomId?: () => string;
};

export type CompilePipelineResult = {
  status: number;
  body: CompileResponseBody;
  usage: UsageState;
  historyEntry: HistoryEntry | null;
};

function emptyRedactionReport(settings: UserSettings) {
  return {
    enabled: settings.secretsProtection,
    strict: settings.strictMode,
    totalRedactions: 0,
    items: [] as Array<{ type: string; count: number; previews: string[] }>,
    strictApplied: false,
  };
}

function defaultMeaningCheck(): MeaningCheckResult {
  return {
    meaning_preserved: true,
    issues: [],
    missing_constraints: [],
    risk: "low",
  };
}

function errorResponse(
  text: string,
  settings: UserSettings,
  usage: UsageState,
  status: number,
  code: string,
  message: string,
  startedAt: number,
  partial?: Partial<CompileReport>
): CompilePipelineResult {
  const tokensReport = buildTokenReport(text, "");
  const report: CompileReport = {
    tokens: tokensReport,
    cost: buildCostReport(tokensReport),
    redactionReport: partial?.redactionReport ?? emptyRedactionReport(settings),
    normalization: partial?.normalization ?? {
      removedDuplicateLines: 0,
      removedDuplicateSentences: 0,
    },
    optimization: partial?.optimization ?? {
      enabled: settings.optimize,
      level: settings.optimize ? settings.optimizeLevel : "off",
      llmUsed: false,
      notes: [],
    },
    checks: partial?.checks ?? {
      enabled: settings.checksEnabled,
      constraintCheck: { passed: true, missing: [] },
      meaningCheck: { passed: true, risk: "low", issues: [] },
      regenerations: 0,
      optimizationFailed: false,
      post_redaction_applied: false,
    },
    cache: partial?.cache ?? { hit: false, key_short: null },
    timing_ms: partial?.timing_ms ?? {
      redaction: 0,
      normalization: 0,
      optimize_llm: 0,
      check_llm: 0,
      total: Date.now() - startedAt,
    },
    usage: usageReport(settings, usage),
  };

  return {
    status,
    usage,
    historyEntry: null,
    body: {
      originalText: text,
      compiledPrompt: "",
      report,
      error: message,
      code,
    },
  };
}

export async function compilePromptPipeline(
  options: CompilePipelineOptions
): Promise<CompilePipelineResult> {
  const requestStart = options.now?.() ?? Date.now();
  const now = options.now?.() ?? Date.now();
  const id = options.randomId ?? (() => crypto.randomUUID());
  const usage = { ...options.usage };
  const { env, settings, cache, text } = options;

  if (now - usage.rpmWindowStart >= 60_000) {
    usage.rpmWindowStart = now;
    usage.rpmCount = 0;
  }

  if (usage.rpmCount >= settings.rpmLimit) {
    return errorResponse(
      text,
      settings,
      usage,
      429,
      "rate_limit_exceeded",
      "Rate limit exceeded",
      requestStart
    );
  }

  usage.rpmCount += 1;

  const redactionStart = options.now?.() ?? Date.now();
  let redactedText = text;
  let redactionReport = emptyRedactionReport(settings);

  if (settings.secretsProtection) {
    const redaction = redactSecrets(text, settings.strictMode);
    redactedText = redaction.redactedText;
    redactionReport = {
      ...redaction.report,
      enabled: settings.secretsProtection,
    };
  }

  const redactionMs = (options.now?.() ?? Date.now()) - redactionStart;
  const normalizationStart = options.now?.() ?? Date.now();
  const normalization = normalizeForOptimization(redactedText);
  const normalizedText = normalization.text;
  const normalizationMs = (options.now?.() ?? Date.now()) - normalizationStart;

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
  let meaningCheckResult = defaultMeaningCheck();
  const canUseLLM = settings.secretsProtection && settings.optimize;
  let checksEnabled = settings.secretsProtection && settings.checksEnabled;
  let cacheKey: string | null = null;
  let shouldCache = false;

  if (settings.optimize && canUseLLM) {
    cacheKey = await sha256Hex(
      JSON.stringify({
        prompt: normalizedText,
        level: settings.optimizeLevel,
        strictMode: settings.strictMode,
        model: DEFAULT_MODEL,
        checks: checksEnabled,
      })
    );
    cacheKeyShort = cacheKey.slice(0, 8);

    const cached = await cache.get(cacheKey);
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
        missing_constraints: constraintCheckResult.missing,
        risk: cached.report.checks.meaningCheck.risk,
      };
    } else {
      shouldCache = true;
      const estimatedOptTokens = estimateCallTokens(normalizedText, OPTIMIZE_MAX_TOKENS);
      if (usage.dailyUsed + estimatedOptTokens > settings.dailyBudget) {
        return errorResponse(
          text,
          settings,
          usage,
          402,
          "daily_budget_exceeded",
          "Daily token budget exceeded",
          requestStart,
          {
            redactionReport,
            normalization: {
              removedDuplicateLines: normalization.removedDuplicateLines,
              removedDuplicateSentences: normalization.removedDuplicateSentences,
            },
            cache: { hit: false, key_short: cacheKeyShort },
            timing_ms: {
              redaction: redactionMs,
              normalization: normalizationMs,
              optimize_llm: 0,
              check_llm: 0,
              total: (options.now?.() ?? Date.now()) - requestStart,
            },
          }
        );
      }

      let optResult: Awaited<ReturnType<typeof llmOptimizePrompt>> | null = null;
      try {
        const optStart = options.now?.() ?? Date.now();
        optResult = await llmOptimizePrompt(env, normalizedText, {
          level: settings.optimizeLevel,
          model: DEFAULT_MODEL,
        });
        optimizeMs += (options.now?.() ?? Date.now()) - optStart;
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

        usage.dailyUsed +=
          (optResult.usage?.input_tokens ?? estimateTokens(normalizedText)) +
          (optResult.usage?.output_tokens ?? OPTIMIZE_MAX_TOKENS);

        let constraintCheck = checkConstraints(redactedText, compiledPrompt);
        let meaningCheck: MeaningCheckResult = meaningCheckResult;

        if (checksEnabled) {
          const estimatedCheckTokens = estimateCallTokens(
            `${redactedText}\n${compiledPrompt}`,
            CHECK_MAX_TOKENS
          );
          if (usage.dailyUsed + estimatedCheckTokens > settings.dailyBudget) {
            checksEnabled = false;
            shouldCache = false;
            cacheKey = null;
            cacheKeyShort = null;
          } else {
            try {
              const checkStart = options.now?.() ?? Date.now();
              const checkResult = await llmCheckMeaning(env, redactedText, compiledPrompt);
              checkMs += (options.now?.() ?? Date.now()) - checkStart;
              if (checkResult.output) meaningCheck = checkResult.output;
              usage.dailyUsed +=
                (checkResult.usage?.input_tokens ??
                  estimateTokens(`${redactedText}\n${compiledPrompt}`)) +
                (checkResult.usage?.output_tokens ?? CHECK_MAX_TOKENS);
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
          if (usage.dailyUsed + estimatedRegenTokens <= settings.dailyBudget) {
            try {
              const regenStart = options.now?.() ?? Date.now();
              const regenResult = await llmOptimizePrompt(env, normalizedText, {
                level: settings.optimizeLevel,
                model: DEFAULT_MODEL,
                fixIssues,
                preserveConstraints: constraintCheck.constraints,
              });
              optimizeMs += (options.now?.() ?? Date.now()) - regenStart;
              regenerateCount += 1;

              if (regenResult.output) {
                compiledPrompt = regenResult.output.optimized_prompt.trim() || compiledPrompt;
                optimizationNotes = regenResult.output.notes ?? optimizationNotes;
                llmUsed = true;
              }

              usage.dailyUsed +=
                (regenResult.usage?.input_tokens ?? estimateTokens(normalizedText)) +
                (regenResult.usage?.output_tokens ?? OPTIMIZE_MAX_TOKENS);

              constraintCheck = checkConstraints(redactedText, compiledPrompt);
              const checkStart = options.now?.() ?? Date.now();
              const checkResult = await llmCheckMeaning(env, redactedText, compiledPrompt);
              checkMs += (options.now?.() ?? Date.now()) - checkStart;
              if (checkResult.output) meaningCheck = checkResult.output;
              usage.dailyUsed +=
                (checkResult.usage?.input_tokens ??
                  estimateTokens(`${redactedText}\n${compiledPrompt}`)) +
                (checkResult.usage?.output_tokens ?? CHECK_MAX_TOKENS);
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
  } else if (settings.optimize) {
    compiledPrompt = deterministicOptimize(normalizedText, settings.optimizeLevel);
    const constraintCheck = checkConstraints(redactedText, compiledPrompt);
    constraintCheckResult.passed = constraintCheck.passed;
    constraintCheckResult.missing = constraintCheck.missing;
    constraintCheckResult.constraints = constraintCheck.constraints;
  }

  const postNormalize = normalizeForOptimization(compiledPrompt);
  compiledPrompt = postNormalize.text;

  const postRedaction = redactSecrets(compiledPrompt, settings.strictMode);
  let postRedactionApplied = false;
  if (postRedaction.redactedText !== compiledPrompt) {
    compiledPrompt = postRedaction.redactedText;
    postRedactionApplied = true;
  }

  const checks: CompileReport["checks"] = {
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
  };

  const optimization: CompileReport["optimization"] = {
    enabled: settings.optimize,
    level: settings.optimize ? settings.optimizeLevel : "off",
    llmUsed,
    notes: optimizationNotes,
  };

  if (shouldCache && cacheKey) {
    await cache.set(cacheKey, {
      compiledPrompt,
      report: { optimization, checks },
      createdAt: options.now?.() ?? Date.now(),
      ttlSeconds: settings.cacheTtlSeconds,
    });
  }

  const tokensReport = buildTokenReport(text, compiledPrompt);
  const costReport = buildCostReport(tokensReport);
  const report: CompileReport = {
    tokens: tokensReport,
    cost: costReport,
    redactionReport,
    normalization: {
      removedDuplicateLines: normalization.removedDuplicateLines,
      removedDuplicateSentences: normalization.removedDuplicateSentences,
    },
    optimization,
    checks,
    cache: { hit: cacheHit, key_short: cacheKeyShort },
    timing_ms: {
      redaction: redactionMs,
      normalization: normalizationMs,
      optimize_llm: optimizeMs,
      check_llm: checkMs,
      total: (options.now?.() ?? Date.now()) - requestStart,
    },
    usage: usageReport(settings, usage),
  };

  const historyEntry: HistoryEntry = {
    id: id(),
    redactedHash: await sha256Hex(redactedText),
    compiledPrompt,
    timestamp: options.now?.() ?? Date.now(),
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

  return {
    status: 200,
    usage,
    historyEntry,
    body: {
      originalText: text,
      compiledPrompt,
      report,
      error: llmError,
    },
  };
}

