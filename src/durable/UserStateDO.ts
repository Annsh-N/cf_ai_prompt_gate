import { compilePromptPipeline } from "../lib/compilePipeline";
import { sha256Hex } from "../lib/hash";
import { DEFAULT_SETTINGS, defaultUsage, normalizeSettings, todayUTC } from "../lib/settings";
import type { CacheEntry, HistoryEntry, UsageState, UserSettings } from "../lib/types";

const SECRET_HASH_KEY = "clientSecretHash";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorJson(status: number, code: string, error: string): Response {
  return json({ error, code }, status);
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length >= 24 ? token : null;
}

export class UserStateDO {
  state: DurableObjectState;
  env: { AI: any };

  constructor(state: DurableObjectState, env: { AI: any }) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const authFailure = await this.authenticate(request);
    if (authFailure) return authFailure;

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

    return errorJson(404, "not_found", "Not found");
  }

  private async authenticate(request: Request): Promise<Response | null> {
    const token = bearerToken(request);
    if (!token) {
      return errorJson(401, "missing_client_secret", "Missing or invalid client secret");
    }

    const candidateHash = await sha256Hex(token);
    const storedHash = await this.state.storage.get<string>(SECRET_HASH_KEY);
    if (!storedHash) {
      await this.state.storage.put(SECRET_HASH_KEY, candidateHash);
      return null;
    }

    if (storedHash !== candidateHash) {
      return errorJson(403, "invalid_client_secret", "Invalid client secret");
    }

    return null;
  }

  private async getSettings(): Promise<UserSettings> {
    const stored = await this.state.storage.get<Partial<UserSettings>>("settings");
    return normalizeSettings(DEFAULT_SETTINGS, stored);
  }

  private async saveSettings(settings: UserSettings) {
    await this.state.storage.put("settings", settings);
  }

  private async getUsage(): Promise<UsageState> {
    const stored = await this.state.storage.get<UsageState>("usage");
    const today = todayUTC();
    if (!stored) {
      const fresh = defaultUsage();
      await this.saveUsage(fresh);
      return fresh;
    }
    if (stored.dailyDate !== today) {
      const reset = { ...stored, dailyDate: today, dailyUsed: 0, rpmWindowStart: 0, rpmCount: 0 };
      await this.saveUsage(reset);
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

  private async handleGetState(): Promise<Response> {
    const settings = await this.getSettings();
    const usage = await this.getUsage();
    const history = await this.getHistory();

    return json({
      settings,
      usage: {
        daily_budget_tokens: settings.dailyBudget,
        daily_used_tokens: usage.dailyUsed,
        daily_remaining_tokens: Math.max(0, settings.dailyBudget - usage.dailyUsed),
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
      return errorJson(400, "invalid_json", "Invalid JSON");
    }

    const current = await this.getSettings();
    const updated = normalizeSettings(current, body?.settings ?? body);
    await this.saveSettings(updated);

    return json({ settings: updated });
  }

  private async handleHistory(): Promise<Response> {
    const entries = await this.getHistory();
    return json({ entries });
  }

  private async handleClearHistory(): Promise<Response> {
    await this.saveHistory([]);
    return json({ ok: true });
  }

  private async handleCompile(request: Request): Promise<Response> {
    let body: any = null;
    try {
      body = await request.json();
    } catch {
      return errorJson(400, "invalid_json", "Invalid JSON");
    }

    const text =
      typeof body?.text === "string"
        ? body.text
        : typeof body?.message === "string"
          ? body.message
          : "";
    const storedSettings = await this.getSettings();
    const settings = normalizeSettings(storedSettings, body?.settingsOverride ?? body?.settings);
    const usage = await this.getUsage();

    const result = await compilePromptPipeline({
      env: this.env,
      text,
      settings,
      usage,
      cache: {
        get: (key) => this.getCache(key),
        set: (key, entry) => this.setCache(key, entry),
      },
    });

    await this.saveUsage(result.usage);
    if (result.historyEntry) {
      await this.appendHistory(result.historyEntry, settings);
    }

    return json(result.body, result.status);
  }
}

