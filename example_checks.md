# Example Checks (manual)

These are quick, manual expectations to validate key helpers without a test runner.

## Redaction
- Input: `contact me jane@example.com or +1 415-555-1212`
  - Expect: `contact me [EMAIL_1] or [PHONE_1]`
- Input: `token=sk-EXAMPLEKEY0000000000000000` (strict mode off)
  - Expect: `token=[SECRET_1]`
- Input: `jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMe` (truncated)
  - Expect: `jwt: [JWT_1]`

## Optimization
- Input:
  ```
  You are an AI.
  You are an AI.

  Please follow these instructions.
  Hello     world
  ```
  - Expect (light): `Hello world`

## Budget + rate limit
- Set `dailyBudget` to 1, send a long prompt.
  - Expect: `Daily token budget exceeded` and HTTP 402.
- Set `rpmLimit` to 1, send two prompts quickly.
  - Expect: second response HTTP 429 with reset time.
