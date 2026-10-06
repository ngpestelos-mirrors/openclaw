import fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import {
  assertSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";

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

  const candidate = { path: capturedAlias, physicalPath: capturedAlias };
  expect(isSessionStoreReadCandidateCurrent(candidate)).toBe(true);
  expect(assertSessionStoreReadCandidate(capturedAlias, [candidate])).toBe(canonicalPath);
});

test("keeps sibling-family custody scoped to the captured directory", () => {
  const familyPath = "/tmp/custom/openclaw-agent.sqlite";
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === familyPath) {
      return "/tmp/database-target/openclaw-agent.sqlite";
    }
    return value;
  });

  expect(
    isSessionStoreReadCandidateCurrent({
      path: familyPath,
      physicalPath: familyPath,
      scope: "sibling-family",
    }),
  ).toBe(true);
});

test("rejects a sibling-family candidate whose directory target changed", () => {
  const familyPath = "/tmp/custom/openclaw-agent.sqlite";
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === "/tmp/custom") {
      return "/tmp/replacement";
    }
    return value;
  });

  expect(
    isSessionStoreReadCandidateCurrent({
      path: familyPath,
      physicalPath: familyPath,
      scope: "sibling-family",
    }),
  ).toBe(false);
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
