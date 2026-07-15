# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open public issues that include secrets, credentials, private prompts, or exploit payloads.

## Threat model

PromptGate reduces accidental leakage from prompt-based AI workflows. The main protected path is:

1. user submits a prompt containing common PII or secret patterns;
2. PromptGate redacts the prompt before Workers AI receives it;
3. compiled output is redacted again before cache/history storage;
4. history stores only compiled prompts and redacted hashes, not raw prompts.

## What is protected

- Common emails, phone numbers, JWTs, bearer tokens, GitHub tokens, Slack tokens, OpenAI-style keys, key-value secrets, and strict high-entropy token candidates.
- Accidental repeated AI calls through TTL cache.
- Cross-user accidental access through per-user bearer-secret binding.
- Basic prompt-output XSS in history rendering by rendering compiled history with `textContent`.

## Limitations

- Redaction is pattern-based and best-effort. It is not a complete DLP system.
- Unknown proprietary secret formats may not be detected.
- Browser local storage is not secure against local machine compromise or malicious extensions.
- The bearer secret is lightweight access control, not OAuth or enterprise identity.
- Live Workers AI benchmarks may incur Cloudflare usage charges.

## Validation

The test and benchmark suites include guards for raw-secret egress:

```bash
npm run check
npm run bench
```

The deterministic benchmark fails if synthetic raw secrets reach the mocked AI request payload.

