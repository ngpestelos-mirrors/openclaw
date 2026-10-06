import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

export type XAllowlistEntry = {
  userId: string;
  username: string;
  name: string;
  addedBy: string;
  addedAt: number;
};

export type XEffectiveAllowlistEntry = {
  userId: string;
  username?: string;
  name?: string;
  addedBy?: string;
  addedAt?: number;
  configured: boolean;
  editable: boolean;
};

export function normalizeXUserId(value: string): string | undefined {
  const id = value.trim().replace(/^x:/i, "");
  return /^[0-9]+$/.test(id) ? id : undefined;
}

const authorityRevisions = new WeakMap<
  object,
  Map<string, { revision: number; pending: number }>
>();

export function openXAllowlist(runtime: { state: Pick<PluginRuntime["state"], "openKeyedStore"> }) {
  let revisions = authorityRevisions.get(runtime);
  if (!revisions) {
    revisions = new Map();
    authorityRevisions.set(runtime, revisions);
  }
  const revisionFor = (accountId: string) => {
    let current = revisions.get(accountId);
    if (!current) {
      current = { revision: 0, pending: 0 };
      revisions.set(accountId, current);
    }
    return current;
  };
  const mutate = async <T>(accountId: string, run: () => Promise<T>): Promise<T> => {
    const current = revisionFor(accountId);
    current.revision++;
    current.pending++;
    try {
      return await run();
    } finally {
      current.pending--;
      current.revision++;
    }
  };
  const store = runtime.state.openKeyedStore<XAllowlistEntry>({
    namespace: "x.allowlist",
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
  });
  const accountPrefix = (accountId: string) => `${encodeURIComponent(accountId)}:`;
  const list = async (accountId: string): Promise<XAllowlistEntry[]> => {
    const prefix = accountPrefix(accountId);
    return (await store.entries())
      .filter((entry) => entry.key.startsWith(prefix))
      .map((entry) => entry.value)
      .toSorted((a, b) => a.userId.localeCompare(b.userId));
  };
  return {
    list,
    captureCurrent(accountId: string): () => void {
      const current = revisionFor(accountId);
      const revision = current.revision;
      return () => {
        if (current.pending || current.revision !== revision) {
          throw new Error("X allowlist changed; send a new mention before publishing work.");
        }
      };
    },
    async readAllowFrom(accountId: string): Promise<string[]> {
      return (await list(accountId)).map((entry) => entry.userId);
    },
    async put(accountId: string, entry: XAllowlistEntry, assertCurrent?: () => void) {
      await mutate(accountId, () =>
        store.register(`${accountPrefix(accountId)}${entry.userId}`, entry, {
          assertCurrent,
        }),
      );
    },
    async remove(accountId: string, userId: string, assertCurrent?: () => void) {
      return await mutate(accountId, () =>
        store.delete(`${accountPrefix(accountId)}${userId}`, { assertCurrent }),
      );
    },
  };
}

export function mergeXAllowlist(
  configAllowFrom: readonly string[],
  stored: readonly XAllowlistEntry[],
): XEffectiveAllowlistEntry[] {
  const entries = new Map<string, XEffectiveAllowlistEntry>();
  for (const entry of stored) {
    entries.set(entry.userId, { ...entry, configured: false, editable: true });
  }
  for (const value of configAllowFrom) {
    const userId = normalizeXUserId(value);
    if (userId) {
      entries.set(userId, {
        ...entries.get(userId),
        userId,
        configured: true,
        editable: entries.has(userId),
      });
    }
  }
  return [...entries.values()].toSorted((a, b) => a.userId.localeCompare(b.userId));
}
