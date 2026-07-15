# Benchmarks

## Command

```bash
npm run bench
```

The benchmark uses `benchmarks/corpus/prompts.json` and a deterministic mocked AI binding. It runs each prompt twice to measure cache miss and cache hit behavior.

## What is measured

- token reduction from original to compiled prompt;
- p50 and p95 request latency;
- cache hit latency versus miss latency;
- AI calls avoided by cache hits;
- redaction-positive requests;
- raw synthetic secret leaks to mocked AI payloads.

## Latest results

See [benchmarks/results/latest.json](../benchmarks/results/latest.json) and [benchmarks/results/latest.md](../benchmarks/results/latest.md).

Current summary:

- 5 corpus cases
- 10 requests
- 0 failed requests
- 33% average token reduction
- 0.75 ms p95 cache-hit latency
- 4 ms p95 miss latency
- 10 AI calls avoided by cache
- 0 raw secret leaks to mocked AI

## Live AI mode

```bash
npm run bench:live
```

This command is reserved for environments with valid Cloudflare Workers AI credentials. Treat live results separately from mocked-AI results because model latency, output shape, and billing behavior vary.
