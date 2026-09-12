import { readFileSync } from "node:fs";

// Test-only transport routing; provider responses and auth-state mutation remain real.
const options = new URL(import.meta.url).searchParams;
const fixture = new URL(options.get("fixture"));
const clockFile = options.get("clock");
if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1" || !clockFile) {
  throw new Error("Quota fixture requires a loopback HTTP origin and a clock file");
}

const realNow = Date.now.bind(Date);
Date.now = () => {
  const offset = Number(readFileSync(clockFile, "utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Quota clock offset must be a nonnegative integer");
  }
  return realNow() + offset;
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const route =
    url === "https://chatgpt.com/backend-api/wham/usage"
      ? "/core-wham/usage"
      : url === "https://chatgpt.com/backend-api/codex/responses"
        ? "/direct/responses"
        : url === "https://auth.openai.com/oauth/token"
          ? "/oauth/token"
          : undefined;
  if (!route) {
    return originalFetch(input, init);
  }
  const target = new URL(route, fixture);
  const fixtureInit = { ...init };
  delete fixtureInit.dispatcher;
  return originalFetch(input instanceof Request ? new Request(target, input) : target, fixtureInit);
};
// The existing hermetic transport contract also routes guarded OAuth refresh.
globalThis.fetch.mock = {};
