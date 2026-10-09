import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as gatewayLock from "../infra/gateway-lock.js";
import * as lifecycle from "../plugins/plugin-lifecycle-lease.js";
import {
  pluginCliConfigMock,
  readConfigFileSnapshotForWriteMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  updateNpmInstalledPluginsMock,
} from "./plugins-cli-test-helpers.js";

beforeEach(() => {
  resetPluginsCliTestState();
  vi.spyOn(lifecycle, "withPluginLifecycleLease").mockRejectedValue(
    new Error("local database admission reached"),
  );
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
    pid: 12345,
    ownerId: "serving-gateway",
    port: 18789,
    createdAt: new Date(0).toISOString(),
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["registry", "--refresh"],
  ["update", "--all"],
  ["enable", "demo"],
  ["disable", "demo"],
  ["uninstall", "demo", "--force"],
])("refuses %s before local database preparation while the Gateway owns state", async (...args) => {
  await expect(runPluginsCommand(["plugins", ...args])).rejects.toThrow(
    /No local mutation was attempted.*stop the Gateway/su,
  );
  expect(lifecycle.withPluginLifecycleLease).not.toHaveBeenCalled();
  expect(pluginCliConfigMock).not.toHaveBeenCalled();
  expect(readConfigFileSnapshotForWriteMock).not.toHaveBeenCalled();
  expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
});
