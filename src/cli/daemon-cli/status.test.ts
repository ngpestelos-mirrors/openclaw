import { beforeEach, expect, it, vi } from "vitest";
import { fetchNpmPackageTargetStatus } from "../../infra/update-check-package-target.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

const createStatus = (ok = true): DaemonStatus => ({
  service: {
    label: "LaunchAgent",
    loaded: true,
    loadState: { status: "loaded" },
    loadedText: "loaded",
    notLoadedText: "not loaded",
  },
  rpc: { ok },
  extraServices: [],
});

const { gather, print, readService, projectRuntime } = vi.hoisted(() => ({
  gather: vi.fn<(_opts?: unknown) => Promise<DaemonStatus>>(),
  print: vi.fn(),
  readService: vi.fn(),
  projectRuntime: vi.fn(),
}));
const statusOptions = { rpc: {}, probe: true, requireRpc: false, json: false };

vi.mock("../../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));

const { defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../runtime.js", () => ({ defaultRuntime }));
vi.mock("./status.gather.js", () => ({ gatherDaemonStatus: gather }));
vi.mock("./status.print.js", () => ({ printDaemonStatus: print }));
// mock-isolation: service inspection must not inspect this host's managed services or environment.
vi.mock("./status.service.js", () => ({ readDaemonServiceStatus: readService }));
// mock-isolation: deterministic runtime facts avoid host runtime and configuration probes.
vi.mock("./status.projection.js", () => ({ projectDaemonRuntimeStatus: projectRuntime }));

const { runDaemonStatus } = await import("./status.js");

async function expectJsonFailure(
  options: Partial<Parameters<typeof runDaemonStatus>[0]>,
  message: string | ReturnType<typeof expect.stringContaining>,
) {
  await expect(runDaemonStatus({ ...statusOptions, ...options, json: true })).rejects.toThrow(
    "__exit__:1",
  );
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
    ok: false,
    error: { type: "cli_error", message },
  });
  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  gather.mockReset().mockResolvedValue(createStatus());
  readService.mockReset();
  projectRuntime.mockReset();
  vi.mocked(fetchNpmPackageTargetStatus).mockReset();
  print.mockClear();
  defaultRuntime.error.mockClear();
  defaultRuntime.exit.mockClear();
  defaultRuntime.writeJson.mockClear();
  resetRuntimeCapture();
});

it("returns local runtime intent while shared-state diagnostics are unavailable", async () => {
  gather.mockRejectedValue(new Error("Shared state is unavailable"));
  const localService = { service: {}, state: { command: null } };
  readService.mockResolvedValue(localService);
  const projection = {
    cli: { version: "1" },
    runtimeIntent: { runtimeIntent: { status: "known" } },
  };
  projectRuntime.mockResolvedValue(projection);

  await runDaemonStatus({ ...statusOptions, json: true, runtimeIntentOnly: true });
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
    cli: projection.cli,
    service: projection.runtimeIntent,
  });
  expect(projectRuntime).toHaveBeenCalledWith({ deep: true, ...localService });
  expect(gather).not.toHaveBeenCalled();
  expect(print).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
});

it.each([false, true])("confirms repair targets only for deep status (deep=%s)", async (deep) => {
  const gathered = await gather();
  gathered.pluginVersionDrift = {
    gatewayVersion: "2026.7.1-2",
    drifts: [
      {
        pluginId: "brave",
        installedVersion: "2026.7.0",
        gatewayVersion: "2026.7.1-2",
        source: "npm",
        spec: "@openclaw/brave-plugin@2026.7.0",
      },
    ],
  };
  gather.mockResolvedValueOnce(gathered);
  vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
    version: null,
    nodeEngine: null,
    error: "HTTP 404",
  });

  await runDaemonStatus({ ...statusOptions, deep });
  expect(fetchNpmPackageTargetStatus).toHaveBeenCalledTimes(deep ? 1 : 0);
  const printed = print.mock.calls[0]?.[0] as DaemonStatus;
  expect(printed.pluginVersionDrift?.drifts[0]?.targetResolution?.status).toBe(
    deep ? "unresolved" : undefined,
  );
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
});

it.each([
  {
    options: { probe: false },
    message: "--require-rpc needs checking enabled. Remove --no-probe or drop --require-rpc.",
  },
  {
    options: { runtimeIntentOnly: true },
    message: "--runtime-intent-only cannot be combined with --require-rpc.",
  },
])("rejects invalid RPC options: $message", async ({ options, message }) => {
  await expectJsonFailure({ ...options, requireRpc: true }, `Gateway status failed: ${message}`);
  expect(gather).not.toHaveBeenCalled();
  expect(readService).not.toHaveBeenCalled();
});

it("renders service-inspection failures as JSON in JSON mode", async () => {
  const secret = "sk-abcdefghijklmnopqrstuv";
  const error = new Error(`service manager unavailable: Authorization: Bearer ${secret}`);
  error.name = "ServiceManagerError";
  gather.mockRejectedValueOnce(error);

  await expectJsonFailure(
    {},
    expect.stringContaining("Gateway status failed: service manager unavailable"),
  );
  expect(print).not.toHaveBeenCalled();
  expect(JSON.stringify(defaultRuntime.writeJson.mock.calls)).not.toContain(error.name);
  expect(JSON.stringify(defaultRuntime.writeJson.mock.calls)).not.toContain(secret);
});

it("exits only once after printing a failed required RPC probe", async () => {
  gather.mockResolvedValueOnce(createStatus(false));

  await expect(runDaemonStatus({ ...statusOptions, requireRpc: true, json: true })).rejects.toThrow(
    "__exit__:1",
  );

  expect(print.mock.calls).toEqual([[expect.any(Object), { json: true, deep: false }]]);
  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
});
