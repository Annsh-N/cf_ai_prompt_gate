import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

const report = {
  tokens: { original_est: 186, compiled_est: 104, saved: 82, saved_pct: 44 },
  cost: {
    per_1m_input_tokens_usd: 0.3,
    original_est_usd: 0.000056,
    compiled_est_usd: 0.000031,
    saved_usd: 0.000025,
    saved_pct: 45,
  },
  redactionReport: {
    enabled: true,
    strict: true,
    totalRedactions: 5,
    items: [
      { type: "secret", count: 3, previews: ["ex***J7", "gh***56", "ab***56"] },
      { type: "email", count: 1, previews: ["ja***om"] },
      { type: "phone", count: 1, previews: ["+1***12"] },
    ],
    strictApplied: false,
  },
  normalization: { removedDuplicateLines: 3, removedDuplicateSentences: 1 },
  optimization: {
    enabled: true,
    level: "light",
    llmUsed: true,
    notes: ["removed repeated instructions", "preserved safety constraints"],
  },
  checks: {
    enabled: true,
    constraintCheck: { passed: true, missing: [] },
    meaningCheck: { passed: true, risk: "low", issues: [] },
    regenerations: 0,
    optimizationFailed: false,
    post_redaction_applied: false,
  },
  cache: { hit: false, key_short: "4f7d9a21" },
  timing_ms: { redaction: 1, normalization: 1, optimize_llm: 214, check_llm: 97, total: 318 },
  usage: {
    daily_budget_tokens: 20000,
    daily_used_tokens: 782,
    daily_remaining_tokens: 19218,
    rpm_limit: 20,
    rpm_used: 1,
  },
};

function responseJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/state") {
      return responseJson(res, {
        settings: {
          secretsProtection: true,
          strictMode: true,
          optimize: true,
          optimizeLevel: "light",
          checksEnabled: true,
          dailyBudget: 20000,
          rpmLimit: 20,
        },
      });
    }
    if (url.pathname === "/api/history") {
      return responseJson(res, { entries: [] });
    }
    if (url.pathname === "/api/compile") {
      await readBody(req);
      return responseJson(res, {
        originalText: "",
        compiledPrompt:
          "Task:\nWrite a concise recruiter update.\n\nConstraints:\nMention Workers AI, Durable Objects, secret redaction, cache metrics, and budget enforcement.",
        report,
        error: null,
      });
    }
    if (url.pathname === "/api/clear-history") {
      return responseJson(res, { ok: true });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = await readFile(join(process.cwd(), "public", path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 8787;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: "screenshots/ui.png", fullPage: true });

  await page.fill(
    "#messageInput",
    [
      "Write a recruiter update. Write a recruiter update.",
      "Mention Workers AI and Durable Objects.",
      "email: jane@example.com",
      "api_key=example_token_9aB3cD4eF5gH6iJ7",
    ].join("\n")
  );
  await page.click("#sendBtn");
  await page.waitForSelector(".metric");
  await page.locator(".compiler-panel").screenshot({ path: "screenshots/metrics.png" });
} finally {
  await browser.close();
  server.close();
}

