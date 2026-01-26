# Prompt Compiler

Prompt Compiler is a lightweight prompt tool that deterministically redacts secrets/PII, normalizes and deduplicates content, uses Workers AI (Llama 3.3) for semantic optimization, runs checks, and returns a single compiled prompt plus a metrics report.

## Architecture
- Pages UI (single-page app)
- Worker API (`/api/compile`, `/api/state`, `/api/history`)
- Durable Objects for per-user settings, budgets, cache, and history
- Workers AI for semantic optimization and meaning checks

## Screenshots
- UI: `screenshots/ui.png`
- Metrics: `screenshots/metrics.png`

## Quickstart
```bash
npm install
npx wrangler dev
```

Deploy:
```bash
npx wrangler deploy
```

## 90-second demo
1) Paste a prompt with an email or token-like string to verify redaction and previews.
2) Switch optimization to aggressive and compare token savings in metrics.
3) Re-run the same prompt to observe a cache hit.
4) Lower RPM or daily budget to trigger 429/402 responses.

## Report schema (overview)
```json
{
  "originalText": "string",
  "compiledPrompt": "string",
  "report": {
    "tokens": { "original_est": 0, "compiled_est": 0, "saved": 0, "saved_pct": 0 },
    "cost": { "per_1m_input_tokens_usd": 0.3, "original_est_usd": 0, "compiled_est_usd": 0, "saved_usd": 0, "saved_pct": 0 },
    "redactionReport": { "enabled": true, "strict": false, "totalRedactions": 0, "items": [], "strictApplied": false },
    "normalization": { "removedDuplicateLines": 0, "removedDuplicateSentences": 0 },
    "optimization": { "enabled": true, "level": "light", "llmUsed": true, "notes": [] },
    "checks": { "enabled": true, "constraintCheck": {}, "meaningCheck": {}, "regenerations": 0, "optimizationFailed": false, "post_redaction_applied": false },
    "cache": { "hit": false, "key_short": null },
    "timing_ms": { "redaction": 0, "normalization": 0, "optimize_llm": 0, "check_llm": 0, "total": 0 },
    "usage": { "daily_budget_tokens": 0, "daily_used_tokens": 0, "daily_remaining_tokens": 0, "rpm_limit": 0, "rpm_used": 0 }
  }
}
```

## Token estimation + cost
- Token estimates use a simple heuristic: `tokens ~= chars / 4`.
- Default price is `0.3 USD` per 1M input tokens (see `COST_PER_1M_INPUT_TOKENS_USD` in `src/durable/UserStateDO.ts`).

## Security note
- Pattern-based redaction is best-effort; do not paste real secrets.
- The app never sends raw secrets to any LLM; only sanitized text is used for optimization and checks.
- History and cache store only redacted/compiled data.

## Sample prompts
You are an expert assistant. You are an expert assistant. You are an expert assistant.
Please be concise. Please be concise. Please be concise.
Use bullet points. Use bullet points. Use bullet points.
Do not include any sensitive information. Do not include any sensitive information.

TASK:
Write a short LinkedIn message to a Cloudflare recruiter about my Prompt Compiler project. Keep it friendly and professional.

CONTEXT (repeated on purpose):
I built a system that redacts secrets deterministically before any LLM call, then uses Workers AI (Llama 3.3) to semantically compress prompts and output a cleaner, lower-cost prompt for premium LLMs.
I built a system that redacts secrets deterministically before any LLM call, then uses Workers AI (Llama 3.3) to semantically compress prompts and output a cleaner, lower-cost prompt for premium LLMs.

DETAILS:
- Durable Objects store user settings, budgets, and cache metadata.
- It outputs one compiled prompt plus metrics: token savings, cost estimate, cache hit/miss, timing, and a redaction report.
- It never sends raw secrets to the LLM.

FORMATTING PREFERENCES (duplicated on purpose):
- Keep it under 70 words
- Mention Workers AI and Durable Objects
- End with a question asking if they are open to a quick chat
FORMATTING PREFERENCES (repeated):
- Keep it under 70 words
- Mention Workers AI and Durable Objects
- End with a question asking if they are open to a quick chat

SECRETS TO REDACT:
email: annsh.test+cf@gmail.com
phone: +1 (415) 555-0199
password=SuperSecretPass123!
api_key=example_token_9aB3cD4eF5gH6iJ7
GITHUB_TOKEN=example_token_AbCdEfGhIjKlMnOpQrStUvWxYz01
SLACK_TOKEN=example_token_123456789012_abcdef
Authorization: Bearer example.jwt.token

dGhpcy1sb29rcy1saWtlLWJhc2U2NC1zdHVmZi1ub3QtcmVhbAaaaaaaaaaaaaaaaaaaaaaaa
