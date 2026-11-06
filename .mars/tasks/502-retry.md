# Task: retry transient 502/5xx gateway errors in MarsCLI

Owner: MarsAI server team (router). Server-side masking is already live.

## Context

The shared origin host is overloaded by neighbors (load avg 13+). Requests
occasionally die at the CF<->origin boundary with a Cloudflare 502
(`error_category: "origin"`, `"retryable": true, "retry_after": 60`). The
server-side Worker already retries infrastructure 502s up to 3 times; when
even that exhausts, the CLI gets a JSON 502:

```json
{"error":{"message":"Upstream connection failed before the request could be processed. Please retry.","type":"server_error","code":502}}
```

or (rare) a Cloudflare error page with `"cloudflare_error": true`.

## Ask

Add automatic retry for **transient gateway errors only**:

- Retry when: HTTP 502/503/504/529 **and** body is a Cloudflare error page
  (`"cloudflare_error": true` / `origin_bad_gateway`) **or** the exact
  `server_error` shape above.
- **Do NOT retry** other 4xx (401/402/403/429) or model-upstream 5xx JSON
  errors whose message starts with `Upstream error:` — those are real model
  failures, retrying just burns time.
- Backoff: 3 attempts max, e.g. 1s → 3s → 8s (jitter ±20%). Honor
  `retry_after` seconds when the error page provides one, capped at 15s
  (waiting the full 60s makes agent sessions feel dead).
- Never retry a request that already produced visible output bytes (mid-stream
  failures must surface, not silently restart — duplicated partial answers are
  worse than an error).
- If all retries fail, surface the original error plus
  `"the API gateway is overloaded right now; try again shortly"`.

## Do NOT do

- Don't add retry loops anywhere else (the gateway already rotates upstream
  targets internally; stacking more layers causes retry storms).
- Don't cache or dedupe requests by body hash to "make retries safe" —
  unnecessary complexity.
