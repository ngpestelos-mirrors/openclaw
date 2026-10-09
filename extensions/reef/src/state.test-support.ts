import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { vi } from "vitest";

export function createRuntime(stateDir: string, registrationHost: "worker" | "legacy" = "worker") {
  const runtime = createPluginRuntimeMock();
  const stateStores: Array<Pick<PluginStateKeyedStore<unknown>, "createOperation">> = [];
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    stateStores.push(store);
    if (registrationHost === "legacy") {
      const {
        createOperation: _createOperation,
        observe: _observe,
        compareAndApply: _compareAndApply,
        ...legacy
      } = store;
      return legacy;
    }
    return store;
  };
  return Object.assign(runtime, { stateStores });
}

export function createStateTestDirectory(): string {
  resetPluginStateStoreForTests();
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-state-"));
}

export async function cleanupStateTestDirectory(stateDir: string): Promise<void> {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Drain worker admissions before deleting files whose physical identity can be reused.
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
