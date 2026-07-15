import { estimateTokens } from "./tokenEstimate";
import type { CostReport, TokenReport, UserSettings, UsageState } from "./types";

export const COST_PER_1M_INPUT_TOKENS_USD = 0.3;
export const OPTIMIZE_MAX_TOKENS = 700;
export const CHECK_MAX_TOKENS = 400;

export function costFromTokens(tokens: number): number {
  const cost = (tokens * COST_PER_1M_INPUT_TOKENS_USD) / 1_000_000;
  return Number(cost.toFixed(6));
}

export function estimateCallTokens(inputText: string, maxTokens: number): number {
  return estimateTokens(inputText) + maxTokens;
}

export function buildTokenReport(original: string, compiled: string): TokenReport {
  const originalTokens = estimateTokens(original);
  const compiledTokens = estimateTokens(compiled);
  const savedTokens = Math.max(0, originalTokens - compiledTokens);
  const savedPct = originalTokens ? Math.round((savedTokens / originalTokens) * 100) : 0;
  return {
    original_est: originalTokens,
    compiled_est: compiledTokens,
    saved: savedTokens,
    saved_pct: savedPct,
  };
}

export function buildCostReport(tokens: TokenReport): CostReport {
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

export function usageReport(settings: UserSettings, usage: UsageState) {
  return {
    daily_budget_tokens: settings.dailyBudget,
    daily_used_tokens: usage.dailyUsed,
    daily_remaining_tokens: Math.max(0, settings.dailyBudget - usage.dailyUsed),
    rpm_limit: settings.rpmLimit,
    rpm_used: usage.rpmCount,
  };
}

export function formatLLMError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication error|inferenceupstreamerror|10000/i.test(message)) {
    return "Workers AI authentication error. Check your Cloudflare auth and AI binding.";
  }
  return `Workers AI error: ${message}`;
}

