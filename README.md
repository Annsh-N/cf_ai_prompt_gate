# PromptGate

PromptGate is a Cloudflare Workers and Durable Objects prompt gateway. It redacts secrets before AI calls, compiles noisy prompts with Workers AI, validates important constraints, enforces per-user budgets and rate limits, caches safe compiled prompts, and returns a metrics report for every request.

## Why this exists

LLM apps often send raw user prompts directly to inference. PromptGate puts a small infrastructure layer in front of that path:

1. redact secrets and PII deterministically;
2. normalize duplicate prompt content;
3. call Workers AI only with sanitized text;
4. verify constraints and semantic preservation;
5. cache compiled prompts by sanitized prompt hash;
6. track usage, budget, cache, timing, and redaction metrics.

## Screenshots

![PromptGate UI](screenshots/ui.png)

![PromptGate metrics](screenshots/metrics.png)

## Architecture

- Pages-style static UI in `public/`
- Worker router in `src/worker.ts`
- Per-user Durable Object in `src/durable/UserStateDO.ts`
- Testable compile pipeline in `src/lib/compilePipeline.ts`
- Deterministic redaction, normalization, constraint checking, token/cost reporting, and LLM wrappers in `src/lib/`

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for request flow, state layout, and cache behavior.

## Current benchmark results

Generated with `npm run bench` using a deterministic benchmark corpus. The benchmark fails if raw synthetic secrets reach the AI request payload.

| Metric | Value |
| --- | ---: |
| Corpus cases | 5 |
| Requests | 10 |
| Failed requests | 0 |
| Average token reduction | 33% |
| p95 cache-hit latency | 0.75 ms |
| p95 miss latency | 4 ms |
| AI calls avoided by cache | 10 |
| Raw secret leaks to AI | 0 |
| Requests with redactions | 4 |

Full output: [benchmarks/results/latest.json](benchmarks/results/latest.json)

## Quickstart

```bash
npm install
npm run check
npm run bench
npm run dev
```

Deploy:

```bash
npm run deploy
```

Generate screenshots:

```bash
npx playwright install chromium
npm run screenshots
```

## Tests

```bash
npm run typecheck
npm run test
npm run test:worker
npm run check
```

Current local result:

- TypeScript: passing
- Vitest helper/pipeline/DO/UI-source tests: 19 passing
- Cloudflare Workers Vitest smoke tests: 2 passing
- Total: 21 passing tests

Coverage includes redaction patterns, normalization, token/cost reports, constraint validation, LLM JSON parsing, raw-secret egress prevention, cache hits, quota failures, AI fallback, post-LLM redaction, Durable Object bearer-secret binding, CORS preflight, and missing-user validation.

## API overview

All API calls require a `userId` and `Authorization: Bearer <clientSecret>`.

- `POST /api/compile`
- `GET /api/state?userId=<id>`
- `POST /api/state`
- `GET /api/history?userId=<id>`
- `POST /api/clear-history`

The first valid bearer secret seen by a user's Durable Object is hashed and bound to that user. Later requests with a different secret return `403`.

## Security Notes

PromptGate redacts common credential and PII patterns before LLM calls, hashes per-user bearer secrets, and re-redacts compiled output before cache/history storage.

See [SECURITY.md](SECURITY.md) for the detailed threat model.
