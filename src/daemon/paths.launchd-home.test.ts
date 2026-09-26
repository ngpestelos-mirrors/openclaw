import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  resolveDaemonHomeDir,
  resolveLaunchAgentHomeDir,
  resolveGatewayStateDir,
} from "./paths.js";

const external = "/Volumes/external-fixture";
const env = { HOME: external, USER: "spoofed", LOGNAME: "also-spoofed" };
afterEach(() => vi.restoreAllMocks());
function devices(canonicalDevice: number | undefined, homeDevice = 2) {
  const stat = fs.statSync("/");
  vi.spyOn(fs, "statSync").mockImplementation((file) => {
    const device = file === "/" ? 1 : file === external ? homeDevice : canonicalDevice;
    if (device === undefined) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: device });
  });
  const user = os.userInfo();
  vi.spyOn(os, "userInfo").mockReturnValue({ ...user, username: "fixture-user" });
}
it("uses the OS login on the root device without relocating state or trusting spoofed names", () => {
  devices(1);
  expect(resolveLaunchAgentHomeDir(env)).toBe("/Users/fixture-user");
  expect(resolveDaemonHomeDir(env)).toBe(external);
  expect(resolveGatewayStateDir(env)).toBe(path.join(external, ".openclaw"));
});
it.each([undefined, 3])("keeps external home when canonical device is %s", (device) => {
  devices(device);
  expect(resolveLaunchAgentHomeDir(env)).toBe(external);
});
it("keeps a home already on the root device", () => {
  devices(1, 1);
  expect(resolveLaunchAgentHomeDir(env)).toBe(external);
  expect(os.userInfo).not.toHaveBeenCalled();
});
it("does not turn an unavailable filesystem identity into relocation authority", () => {
  devices(1);
  vi.mocked(fs.statSync).mockImplementationOnce(() => {
    throw new Error("stat denied");
  });
  expect(resolveLaunchAgentHomeDir(env)).toBe(external);
});
