import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { TelegramPollRegistryEntry } from "./poll-registry.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

export function setTelegramPluginStateRuntimeForTests(): void {
  setTelegramRuntime({
    state: {
      openKeyedStore: ((options) =>
        createPluginStateKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openKeyedStore"],
      openSyncKeyedStore: ((options) =>
        createPluginStateSyncKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openSyncKeyedStore"],
    },
    channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
  } as TelegramRuntime);
}

export function installTelegramIngressQueueRuntime(
  resolveStateDir: () => string,
  queueOpenError?: Error,
): void {
  setTelegramRuntime({
    channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
    state: {
      resolveStateDir,
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
      ) => {
        if (queueOpenError) {
          throw queueOpenError;
        }
        return createChannelIngressQueueForTests({ ...options, channelId: "telegram" });
      },
    },
  } as TelegramRuntime);
}

export function setTelegramPollRegistryRuntimeForTests(
  store: PluginStateKeyedStore<TelegramPollRegistryEntry>,
): void {
  setTelegramRuntime({
    state: {
      openKeyedStore: (() => store) as TelegramRuntime["state"]["openKeyedStore"],
    },
    channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
  } as TelegramRuntime);
}

export function clearTelegramSessionStateFilesForTests(sessionStorePath: string): void {
  rmSync(`${sessionStorePath}.telegram-messages.json`, { force: true });
  const dir = path.dirname(sessionStorePath);
  if (!existsSync(dir)) {
    return;
  }
  const prefix = `${path.basename(sessionStorePath)}.telegram-message-dispatch-`;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(prefix)) {
      rmSync(path.join(dir, entry), { force: true });
    }
  }
}
