import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accountEnv, LIMIT_RE, parseProbe, parseSetupToken } from "./claude-accounts.ts";

test("parseSetupToken: url and token out of an ANSI pty stream", () => {
  const raw = "\x1b[2J\x1b[1mBrowser didn't open? Use the url below\x1b[0m\r\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\r\nPaste code here if prompted > \r\n\x1b[32m✓ Long-lived authentication token created\x1b[0m\r\nYour OAuth token (valid for 1 year):\r\nsk-ant-oat01-AbC_d-123\r\n";
  assert.deepEqual(parseSetupToken(raw), { prompted: true, url: "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz", token: "sk-ant-oat01-AbC_d-123", error: null });
  assert.deepEqual(parseSetupToken("nothing yet"), { prompted: false, url: null, token: null, error: null });
  assert.equal(parseSetupToken("\x1b[1m\r\nOAuth error: Request failed with status code 400\r\nPress Enter to retry.").error, "Request failed with status code 400");
});

test("accountEnv: blanks other credentials, sets the chosen one; no account = machine login", () => {
  assert.deepEqual(accountEnv(null), {});
  assert.deepEqual(accountEnv({ method: "api_key", secret: "sk-ant-k" }), { ANTHROPIC_API_KEY: "sk-ant-k", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" });
  assert.deepEqual(accountEnv({ method: "oauth", secret: "sk-ant-oat01-t" }), { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-t" });
});

test("parseProbe: result and plan usage from stream-json", () => {
  const out = [
    '{"type":"system","subtype":"init"}',
    '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.01,"resetsAt":1792241400},"seven_day":{"utilization":0.14,"resetsAt":1792699200}}}}',
    '{"type":"result","is_error":false,"result":"ok"}',
  ].join("\n");
  assert.deepEqual(parseProbe(out), { result: "ok", isError: false, usage: { five_hour: { utilization: 1, resets_at: "2026-10-17T12:50:00.000Z" }, seven_day: { utilization: 14, resets_at: "2026-10-22T20:00:00.000Z" } } });
  assert.deepEqual(parseProbe("garbage"), { result: null, isError: false, usage: undefined });
});

test("LIMIT_RE: quota errors yes, auth and unrelated errors no", () => {
  for (const m of ["5-hour limit reached ∙ resets 3pm", "Claude AI usage limit reached", "API Error: 429 rate_limit_error", "You have exceeded your weekly quota", "Too many requests"]) assert.match(m, LIMIT_RE, m);
  for (const m of ["Authentication required", "invalid x-api-key", "ENOENT: no such file", "context window is full"]) assert.doesNotMatch(m, LIMIT_RE, m);
});
