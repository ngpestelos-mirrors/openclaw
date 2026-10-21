import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findInstalledSystemdGatewayScope, isNonFatalSystemdInstallProbeError } from "./systemd.js";

const findServices = vi.hoisted(() =>
  vi.fn<typeof import("./inspect.js").findSystemGatewayServices>(async () => []),
);
vi.mock("./inspect.js", () => ({ findSystemGatewayServices: () => findServices() }));
const HOME = "/tmp/openclaw-test-home";
const systemPath = (name: string) => `/etc/systemd/system/${name}.service`;
const userPath = (name: string) => `${HOME}/.config/systemd/user/${name}.service`;
const findScope = (profile?: string, override?: string) =>
  findInstalledSystemdGatewayScope({
    HOME,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_SYSTEMD_UNIT: override,
  });
let files: string[];

function marker(name: string) {
  findServices.mockResolvedValueOnce([
    {
      platform: "linux",
      label: `${name}.service`,
      detail: `unit: ${systemPath(name)}`,
      sourcePath: systemPath(name),
      scope: "system",
      marker: "openclaw",
    },
  ]);
}

beforeEach(() => {
  files = [];
  findServices.mockReset().mockResolvedValue([]);
  vi.spyOn(fs, "access").mockImplementation(async (file) => {
    if (!files.includes(String(file))) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["user", "EACCES"],
  ["user", "EIO"],
  ["system", "EACCES"],
  ["system", "EIO"],
])("reports %s unit inspection failure %s instead of absence", async (scope, code) => {
  const unitPath = (scope === "user" ? userPath : systemPath)("openclaw-gateway");
  const inspectionError = Object.assign(new Error("unit inspection failed"), { code });
  vi.spyOn(fs, "access").mockImplementation(async (file) => {
    throw String(file) === unitPath
      ? inspectionError
      : Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });

  await expect(findScope()).rejects.toBe(inspectionError);
});

it("selects marker-owned, legacy, and explicitly requested units (openclaw#119648)", async () => {
  const cases = [
    [undefined, undefined, "openclaw", "marker"],
    ["lisa", undefined, "openclaw-lisa", "system"],
    ["lisa", "openclaw-node", "openclaw-node", "system"],
    ["lisa", "openclaw-gateway-lisa", "openclaw-gateway-lisa", "user"],
  ] as const;
  for (const [profile, override, name, source] of cases) {
    const scope = source === "user" ? "user" : "system";
    const unitPath = (scope === "user" ? userPath : systemPath)(name);
    files = source === "marker" ? [] : [unitPath];
    if (source === "marker") {
      marker(name);
    }
    await expect(findScope(profile, override)).resolves.toEqual({
      scope,
      unitName: `${name}.service`,
      unitPath,
    });
  }
});

it("refuses marker units outside the selected profile or explicit identity", async () => {
  const cases = [
    ["lisa", undefined, "openclaw-darlene"],
    ["Lisa", undefined, "openclaw-gateway-lisa"],
    [undefined, undefined, "my-custom-gateway"],
    [undefined, "my-gateway", "my-gateway@"],
    [undefined, "my-gateway", "my-gateway@gateway"],
    [undefined, "openclaw@gateway.service", "openclaw@other"],
    [undefined, "openclaw-node", "openclaw-darlene"],
  ] as const;
  for (const [profile, override, name] of cases) {
    marker(name);
    await expect(findScope(profile, override)).resolves.toBeNull();
  }
});

it("rejects legacy aliases that collide with Node or another canonical profile", async () => {
  files = ["openclaw-node", "openclaw-gateway", "openclaw-gateway-lisa"].map(userPath);
  for (const profile of ["node", "gateway", "gateway-lisa"]) {
    await expect(findScope(profile)).resolves.toBeNull();
  }
});

it.each(["disk", "marker"])(
  "preserves an explicit instance with only its template on %s",
  async (source) => {
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "unrelated-login",
      uid: 1000,
      gid: 1000,
      homedir: HOME,
      shell: "/bin/sh",
    });
    if (source === "disk") {
      files = [systemPath("openclaw@")];
    } else {
      marker("openclaw@");
    }
    await expect(findScope(undefined, "openclaw@gateway.service")).resolves.toEqual({
      scope: "system",
      unitName: "openclaw@gateway.service",
      unitPath: systemPath("openclaw@"),
    });
  },
);

it("classifies unavailable install probes without hiding infrastructure failures", () => {
  for (const [message, expected] of [
    ["Command failed: systemctl --user is-enabled openclaw-gateway.service", true],
    ["systemctl is-enabled unavailable: Failed to connect to bus", true],
    ["systemctl is-enabled unavailable: read-only file system", false],
  ] as const) {
    expect(isNonFatalSystemdInstallProbeError(new Error(message))).toBe(expected);
  }
});
