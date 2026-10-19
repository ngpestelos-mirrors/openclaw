import { Command } from "commander";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, expect, vi } from "vitest";
import { registerGoogleMeetCli } from "../cli.js";
import { resolveGoogleMeetConfig } from "../config.js";
import type { GoogleMeetRuntime } from "../runtime.js";
import { meetApiFixtures } from "./fixtures.test-helpers.js";

export { captureStdout } from "./fixtures.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
    }): Promise<{
      response: Response;
      release: () => Promise<void>;
    }> => ({
      response: await fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
  };
});

export function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

export function parseStdoutJson(stdout: { output: () => string }): Record<string, unknown> {
  return JSON.parse(stdout.output()) as Record<string, unknown>;
}

export function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

export function stubMeetArtifactsApi(
  options: { failSmartNoteDocumentBody?: boolean; participantDisplayName?: string } = {},
) {
  const fixtures: Record<string, unknown> = meetApiFixtures(options);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (fixtures[url.pathname]) {
        return jsonResponse(fixtures[url.pathname]);
      }
      if (url.pathname === "/drive/v3/files/doc-1/export") {
        return new Response("Transcript document body.", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      if (url.pathname === "/drive/v3/files/notes-1/export") {
        if (options.failSmartNoteDocumentBody) {
          return new Response("insufficientPermissions", { status: 403 });
        }
        return new Response("Smart note document body.", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

export function setupCli(params: {
  config?: Parameters<typeof resolveGoogleMeetConfig>[0];
  runtime?: Partial<GoogleMeetRuntime>;
  ensureRuntime?: () => Promise<GoogleMeetRuntime>;
  callGatewayFromCli?: typeof gatewayRuntime.callGatewayFromCli;
}) {
  vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(
    params.callGatewayFromCli ??
      (async () => {
        throw Object.assign(new Error("gateway transport failed"), {
          name: "GatewayTransportError",
          kind: "closed",
          connectionDetails: { url: "ws://127.0.0.1:18789" },
        });
      }),
  );
  const program = new Command();
  registerGoogleMeetCli({
    program,
    config: resolveGoogleMeetConfig(params.config ?? {}),
    ensureRuntime:
      params.ensureRuntime ?? (async () => (params.runtime ?? {}) as unknown as GoogleMeetRuntime),
  });
  return program;
}
