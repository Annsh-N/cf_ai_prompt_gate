# PromptGate Architecture

## Request flow

1. The browser stores a generated `userId` and `clientSecret` in local storage.
2. The Worker routes `/api/*` requests to a Durable Object selected by `userId`.
3. The Durable Object hashes and binds the first valid bearer secret for that user.
4. `/api/compile` loads settings and usage state, then calls the shared compile pipeline.
5. The pipeline redacts, normalizes, optimizes, validates, re-redacts, reports metrics, and returns a history entry.
6. The Durable Object persists updated usage, cache entries, settings, and redacted history.

## Durable Object state

- `clientSecretHash`: SHA-256 hash of the first accepted bearer secret.
- `settings`: per-user compile settings, budget, RPM, cache TTL, and history length.
- `usage`: daily token usage and current RPM window.
- `history`: bounded list of redacted compiled prompts and summary metrics.
- `cache:<sha256>`: compiled prompt and validation report for a sanitized prompt, optimization level, model, strict mode, and check setting.

## Compile pipeline

The shared pipeline in `src/lib/compilePipeline.ts` is used by both the Durable Object and benchmarks.

- Redaction runs before any LLM call when `secretsProtection` is enabled.
- Normalization removes duplicate lines/sentences and compresses whitespace.
- Cache lookup happens on sanitized prompt content, not raw prompt content.
- Workers AI optimization receives only redacted text.
- Constraint and meaning checks can trigger one regeneration.
- Final output is normalized and redacted again before cache/history storage.
- Every response includes token, cost, redaction, cache, timing, usage, and validation metrics.

## Failure behavior

- Missing or malformed JSON returns `400`.
- Missing bearer secret returns `401`.
- Wrong bearer secret returns `403`.
- RPM exhaustion returns `429`.
- Daily token budget exhaustion returns `402`.
- Workers AI errors fall back to deterministic sanitized output and include the error in the response.

