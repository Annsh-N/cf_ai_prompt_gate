import type { MeaningCheckResult } from "./llmCheck";
import type { OptimizationLevel } from "./llmOptimize";

export type UserSettings = {
  secretsProtection: boolean;
  strictMode: boolean;
  optimize: boolean;
  optimizeLevel: OptimizationLevel;
  checksEnabled: boolean;
  dailyBudget: number;
  rpmLimit: number;
  cacheTtlSeconds: number;
  historyMax: number;
};

export type UsageState = {
  dailyDate: string;
  dailyUsed: number;
  rpmWindowStart: number;
  rpmCount: number;
};

export type TokenReport = {
  original_est: number;
  compiled_est: number;
  saved: number;
  saved_pct: number;
};

export type CostReport = {
  per_1m_input_tokens_usd: number;
  original_est_usd: number;
  compiled_est_usd: number;
  saved_usd: number;
  saved_pct: number;
};

export type CompileReport = {
  tokens: TokenReport;
  cost: CostReport;
  redactionReport: {
    enabled: boolean;
    strict: boolean;
    strictApplied: boolean;
    totalRedactions: number;
    items: Array<{ type: string; count: number; previews: string[] }>;
  };
  normalization: {
    removedDuplicateLines: number;
    removedDuplicateSentences: number;
  };
  optimization: {
    enabled: boolean;
    level: OptimizationLevel | "off";
    llmUsed: boolean;
    notes: string[];
  };
  checks: {
    enabled: boolean;
    constraintCheck: { passed: boolean; missing: string[] };
    meaningCheck: {
      passed: boolean;
      risk: MeaningCheckResult["risk"];
      issues: string[];
    };
    regenerations: number;
    optimizationFailed: boolean;
    post_redaction_applied: boolean;
  };
  cache: { hit: boolean; key_short: string | null };
  timing_ms: {
    redaction: number;
    normalization: number;
    optimize_llm: number;
    check_llm: number;
    total: number;
  };
  usage: {
    daily_budget_tokens: number;
    daily_used_tokens: number;
    daily_remaining_tokens: number;
    rpm_limit: number;
    rpm_used: number;
  };
};

export type CacheEntry = {
  compiledPrompt: string;
  report: {
    optimization: CompileReport["optimization"];
    checks: CompileReport["checks"];
  };
  createdAt: number;
  ttlSeconds: number;
};

export type HistoryEntry = {
  id: string;
  redactedHash: string;
  compiledPrompt: string;
  timestamp: number;
  report: {
    tokens: TokenReport;
    cost: Omit<CostReport, "per_1m_input_tokens_usd">;
    cache: { hit: boolean; key_short: string | null };
  };
};

export type CompileResponseBody = {
  originalText: string;
  compiledPrompt: string;
  report: CompileReport;
  error: string | null;
  code?: string;
};

