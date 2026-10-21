import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assertMxcReadiness, warnMxcHostPrepIfNeeded } from "../src/readiness.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}
beforeEach(() => {
  setPlatform("win32");
  vi.mocked(execFileSync).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
});

const SYSTEM32 = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
);
const ICACLS = path.win32.join(SYSTEM32, "icacls.exe");
const MXC_EXE = "C:\\mxc\\bin\\x64\\wxc-exec.exe";
const unpreparedAcl = "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n";
const assertReady = () => assertMxcReadiness({ executablePath: MXC_EXE });

function probeOutput(result: Record<string, unknown>): string {
  return JSON.stringify({ warnings: [], probes: {}, ...result });
}

// The fake has no sc.exe: only the selected MXC executable answers --probe.
function mockProbe(params: { probe?: string | Error; systemDriveAcl?: string } = {}) {
  const probe = params.probe ?? probeOutput({ tier: "base-container" });
  const systemDriveAcl = params.systemDriveAcl ?? `${unpreparedAcl}    S-1-15-2-1:(R)\n`;
  return vi.mocked(execFileSync).mockImplementation((command, args = []) => {
    if (command === MXC_EXE && args[0] === "--probe") {
      if (probe instanceof Error) {
        throw probe;
      }
      return probe;
    }
    if (command === ICACLS) {
      return systemDriveAcl;
    }
    throw new Error(`spawn ${command} ENOENT`);
  });
}

describe("assertMxcReadiness", () => {
  test("is a no-op on non-Windows platforms", () => {
    setPlatform("linux");
    const exec = mockProbe({ probe: new Error("probe must not run") });

    expect(assertReady).not.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  test("reports tier degradation without requiring system-drive preparation", () => {
    mockProbe({
      systemDriveAcl: unpreparedAcl,
      probe: probeOutput({
        tier: "appcontainer-dacl",
        warnings: ["BaseContainer API is not present on this host"],
      }),
    });

    expect(assertReady).not.toThrow();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toMatch(
      /appcontainer-dacl isolation tier: BaseContainer API is not present/u,
    );
  });

  test.each([
    [
      "no isolation tier",
      probeOutput({ error: "DACL fallback required but fallback.allowDaclMutation is false" }),
      /cannot select an isolation tier on this host \(DACL fallback required.*--probe for host details/u,
    ],
    [
      "an unsupported tier even with a successful probe",
      probeOutput({ tier: "none", error: "isolation unavailable" }),
      /host check returned an unexpected result.*--probe for host details/u,
    ],
    [
      "non-JSON output",
      "wxc-exec: unknown option --probe",
      /host check did not return JSON.*older executor.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath/u,
    ],
  ] as const)("rejects %s", (_name, probe, error) => {
    mockProbe({ probe });
    expect(assertReady).toThrow(error);
  });
});

describe("warnMxcHostPrepIfNeeded", () => {
  test("is a no-op on non-Windows platforms", () => {
    setPlatform("linux");
    mockProbe();

    warnMxcHostPrepIfNeeded();
    expect(console.warn).not.toHaveBeenCalled();
  });

  test("warns when the system drive lacks AppContainer ACEs", () => {
    mockProbe({ systemDriveAcl: unpreparedAcl });

    warnMxcHostPrepIfNeeded();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toMatch(/prepare-system-drive/u);
  });
});
