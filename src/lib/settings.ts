import type { OptimizationLevel } from "./llmOptimize";
import type { UserSettings, UsageState } from "./types";

export const DEFAULT_SETTINGS: UserSettings = {
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

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultUsage(now = Date.now()): UsageState {
  return {
    dailyDate: new Date(now).toISOString().slice(0, 10),
    dailyUsed: 0,
    rpmWindowStart: 0,
    rpmCount: 0,
  };
}

function clampNumber(value: unknown, fallback: number, min = 0, max = 1000000) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSettings(
  base: UserSettings,
  override?: Partial<UserSettings>
): UserSettings {
  if (!override) return base;
  return {
    secretsProtection: clampBoolean(override.secretsProtection, base.secretsProtection),
    strictMode: clampBoolean(override.strictMode, base.strictMode),
    optimize: clampBoolean(override.optimize, base.optimize),
    optimizeLevel:
      override.optimizeLevel === "aggressive" || override.optimizeLevel === "light"
        ? override.optimizeLevel
        : base.optimizeLevel,
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

