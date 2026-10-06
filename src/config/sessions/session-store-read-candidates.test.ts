import fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { isSessionStoreReadCandidateCurrent } from "./session-store-read-candidates.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("keeps custody when a captured alias later resolves to the same file", () => {
  const capturedAlias = "/tmp/RUNNER~1/home/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const canonicalPath = "/tmp/runneradmin/home/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === capturedAlias) {
      return canonicalPath;
    }
    return value;
  });

  expect(
    isSessionStoreReadCandidateCurrent({
      path: capturedAlias,
      physicalPath: capturedAlias,
    }),
  ).toBe(true);
});

test("rejects a candidate whose lexical target changed", () => {
  const capturedAlias = "/tmp/RUNNER~1/openclaw-agent.sqlite";
  const replacement = "/tmp/replacement/openclaw-agent.sqlite";
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === capturedAlias) {
      return "/tmp/runneradmin/openclaw-agent.sqlite";
    }
    return value;
  });

  expect(
    isSessionStoreReadCandidateCurrent({ path: replacement, physicalPath: capturedAlias }),
  ).toBe(false);
});
