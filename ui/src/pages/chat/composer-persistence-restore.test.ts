// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatGoalDraftMode, ChatReplyTarget } from "../../lib/chat/chat-types.ts";
import * as draftStore from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import {
  storageTargetForComposer,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ChatComposerPersistence,
  loadChatComposerState as load,
  restoreChatComposerState as restore,
  persistChatComposerState as persist,
} from "./composer-persistence.ts";
import * as durableComposer from "./durable-composer-persistence.ts";

type ReadResult = Awaited<ReturnType<typeof draftStore.readDurableComposerDraft>>;
type FoundDraft = Extract<ReadResult, { status: "found" }>["draft"];
let write = draftStore.writeDurableComposerDraft;
function foundDraft(text: string, writeId: string, fields: Partial<FoundDraft> = {}): ReadResult {
  return { status: "found", draft: { revision: 1, text, attachments: [], writeId, ...fields } };
}
type State = NonNullable<ReturnType<ConstructorParameters<typeof ChatComposerPersistence>[0]>>;
const cleanups: (() => void | Promise<void>)[] = [];
function persistenceFor(state: State, keepOwner = false, release = () => {}) {
  let owner: State | undefined = state;
  const persistence = new ChatComposerPersistence(() => owner);
  cleanups.push(async () => {
    if (!keepOwner) {
      owner = undefined;
    }
    persistence.stop();
    release();
    await settleStorage();
  });
  persistence.start();
  return persistence;
}
function pendingRestore(state: State) {
  const pending = createDeferred<ReadResult>();
  const read = vi.spyOn(draftStore, "readDurableComposerDraft").mockReturnValue(pending.promise);
  const persistence = persistenceFor(state, false, () =>
    pending.resolve({ status: "not-found", revision: 0 }),
  );
  return { pending, read, persistence };
}
function retireDraft() {
  return vi
    .spyOn(draftStore, "retireDurableComposerDraft")
    .mockResolvedValue({ status: "persisted" });
}
function expectWrite(
  scope: unknown,
  draft: Record<string, unknown>,
  options: unknown = expect.anything(),
) {
  expect(write).toHaveBeenCalledWith(scope, expect.objectContaining(draft), options);
}
function offlineSelection() {
  return {
    ...createState(),
    client: null,
    connected: false,
    chatGoalDraftMode: null as ChatGoalDraftMode | null,
    chatReplyTarget: null as ChatReplyTarget | null,
  };
}

function createState() {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:main:restore",
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    client: { recoveryScope: "test-owner", recoveryScopeReady: true },
    connected: true,
    selectedChatSessionIncognito: false,
  };
}

// Storage uses controlled promises; drain their restore/write continuations before assertions.
const settleStorage = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.spyOn(draftStore, "prepareDurableComposerRecovery").mockResolvedValue({
    status: "ready",
    entries: [],
  });
  write = vi
    .spyOn(draftStore, "writeDurableComposerDraft")
    .mockResolvedValue({ status: "persisted" });
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it.each([
  { boundary: "gateway", privateSource: false },
  { boundary: "credential", privateSource: false },
  { boundary: "gateway", privateSource: true },
  { boundary: "credential", privateSource: true },
])("captures $boundary ownership (private=$privateSource)", async ({ boundary, privateSource }) => {
  vi.spyOn(draftStore, "readDurableComposerDraft").mockResolvedValue({
    status: "not-found",
    revision: 0,
  });
  const retire = retireDraft();
  const state = createState();
  state.selectedChatSessionIncognito = privateSource;
  state.chatMessage = "Source initial input";
  const persistence = persistenceFor(state);
  await settleStorage();
  const sourceScope = persistence.durableScope;
  state.chatMessage = "Captured source input";
  persistence.schedule();
  if (boundary === "gateway") {
    state.settings = { gatewayUrl: "ws://destination.test/control" };
  } else {
    state.client = { recoveryScope: "destination-owner", recoveryScopeReady: true };
  }
  state.selectedChatSessionIncognito = !privateSource;
  state.chatMessage = "Destination input";
  if (privateSource) {
    expect(persist(state)).toBe(true);
  }
  const destinationKey = storageTargetForComposer(state).key;
  const destinationMetadata = sessionStorage.getItem(destinationKey);
  vi.mocked(write).mockClear();
  retire.mockClear();
  persistence.persistNow();
  await settleStorage();
  expect(retire).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(destinationKey)).toBe(destinationMetadata);
  if (privateSource) {
    expect(write).not.toHaveBeenCalled();
    expect(load(state, state.sessionKey).snapshot?.draft).toBe("Destination input");
  } else {
    expectWrite(sourceScope, { text: "Captured source input" });
  }
  expect(state.chatMessage).toBe("Destination input");
});

it("retires the durable draft when a write notification reveals Incognito metadata", async () => {
  vi.spyOn(draftStore, "readDurableComposerDraft").mockResolvedValue(
    foundDraft("Previously stored input", "previous"),
  );
  const retire = retireDraft();
  const state = createState();
  const persistence = persistenceFor(state, true);
  await settleStorage();
  const capturedScope = persistence.durableScope;
  expect(capturedScope).not.toBeNull();
  vi.mocked(write).mockClear();
  const unsubscribe = subscribeStoredChatOutboxChanges(() => {
    state.selectedChatSessionIncognito = true;
    persistence.persistChangedState();
  });
  cleanups.push(unsubscribe);
  state.chatMessage = "";
  persistence.schedule();
  persistence.persistNow();
  await settleStorage();
  expect(state.selectedChatSessionIncognito).toBe(true);
  expect(retire).toHaveBeenCalledWith(capturedScope, expect.any(Number));
  expect(write).not.toHaveBeenCalled();
  expect(state.chatMessage).toBe("");
});

it("retires private tab input when a pending snapshot predates the authenticated owner", async () => {
  const retire = retireDraft();
  const state = createState();
  state.connected = false;
  state.client = { recoveryScope: "", recoveryScopeReady: false };
  state.chatMessage = "Previously persisted private input";
  expect(persist(state)).toBe(false);
  const persistence = persistenceFor(state);
  state.chatMessage = "Current private input";
  persistence.schedule();
  state.connected = true;
  state.client.recoveryScope = "authenticated-owner";
  state.client.recoveryScopeReady = true;
  state.selectedChatSessionIncognito = true;
  persistence.persistChangedState();
  await settleStorage();
  const stored = sessionStorage.getItem(storageTargetForComposer(state).key);
  expect(stored ?? "").not.toContain("Previously persisted private input");
  expect(stored ?? "").not.toContain("Current private input");
  expect(state.chatMessage).toBe("Current private input");
  expect(retire).toHaveBeenCalledWith(
    expect.objectContaining({ recoveryScope: "authenticated-owner" }),
    expect.any(Number),
  );
});

it.each([false, true])(
  "restores metadata without replacing a pre-auth edit (%s)",
  async (edited) => {
    const goalMode: ChatGoalDraftMode = { action: "start", sessionId: "saved-session" };
    vi.spyOn(draftStore, "readDurableComposerDraft").mockResolvedValue(
      foundDraft("Saved draft", "saved-draft", { goalMode }),
    );
    const state = {
      ...createState(),
      connected: false,
      client: { recoveryScope: "", recoveryScopeReady: false, offlineRecoveryScope: "test-owner" },
      chatMessage: "Saved draft",
      chatGoalDraftMode: null as ChatGoalDraftMode | null,
    };
    expect(persist(state, state.sessionKey, { draftRevision: 1 })).toBe(true);
    const persistence = persistenceFor(state);
    if (edited) {
      state.chatMessage = "New edit before authentication";
      persistence.schedule();
    }
    state.connected = true;
    state.client.recoveryScope = "test-owner";
    state.client.recoveryScopeReady = true;
    persistence.persistChangedState();
    await settleStorage();
    expect(state.chatMessage).toBe(edited ? "New edit before authentication" : "Saved draft");
    expect(state.chatGoalDraftMode).toEqual(edited ? null : goalMode);
    if (edited) {
      expectWrite(expect.objectContaining({ recoveryScope: "test-owner" }), {
        text: "New edit before authentication",
      });
    } else {
      expect(write).not.toHaveBeenCalled();
    }
  },
);

it("captures once per restore admission while pending, settled, reset, and switching scope", async () => {
  const capture = vi.spyOn(durableComposer, "captureDurableChatAttachments");
  const state = createState();
  state.chatMessage = "Saved draft";
  expect(persist(state, state.sessionKey, { draftRevision: 1 })).toBe(true);
  const { pending, read, persistence } = pendingRestore(state);
  const expectUncaptured = (repeat = 1) => {
    capture.mockClear();
    for (let index = 0; index < repeat; index++) {
      persistence.persistChangedState();
    }
    expect(capture).not.toHaveBeenCalled();
  };
  expect(capture).toHaveBeenCalled();
  expectUncaptured(3);
  await settleStorage();
  expect(read).toHaveBeenCalledOnce();

  pending.resolve({ status: "not-found", revision: 0 });
  await settleStorage();
  expectWrite(
    expect.objectContaining({ recoveryScope: "test-owner" }),
    { revision: 1, text: "Saved draft", attachments: [] },
    expect.objectContaining({ expectedRevision: 0 }),
  );
  expectUncaptured(3);
  expect(read).toHaveBeenCalledOnce();

  persistence.restore();
  capture.mockClear();
  persistence.persistChangedState();
  expect(capture).toHaveBeenCalledOnce();
  expectUncaptured();
  await settleStorage();
  expect(read).toHaveBeenCalledTimes(2);

  state.sessionKey = "agent:main:other";
  persistence.persistChangedState();
  await settleStorage();
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({ scopeKey: expect.stringContaining("agent:main:other") }),
  );
  expectUncaptured();
});

it("keeps a synchronous reply cancellation when an older stored draft has a higher revision", async () => {
  // Scheduling must stay below the stored revision even if the test process pauses.
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const storedRevision = nextDraftRevision() + 100;
  const previousReply = { messageId: "previous", text: "Previous selection" };
  const state: ReturnType<typeof createState> & { chatReplyTarget: ChatReplyTarget | null } = {
    ...createState(),
    chatReplyTarget: previousReply,
  };
  expect(persist(state, state.sessionKey, { draftRevision: 1 })).toBe(true);
  const { pending, read, persistence } = pendingRestore(state);
  state.chatReplyTarget = null;
  persistence.schedule();
  await settleStorage();
  expect(read).toHaveBeenCalledOnce();
  pending.resolve(
    foundDraft("Older saved draft", "stored-draft", {
      revision: storedRevision,
      replyTarget: previousReply,
    }),
  );
  await settleStorage();
  expect(state).toMatchObject({ chatMessage: "", chatReplyTarget: null });
});

it("persists empty goal selection and versions cancellation", () => {
  const state = offlineSelection();
  const persistence = new ChatComposerPersistence(() => state);
  persistence.start();
  state.chatGoalDraftMode = { action: "start", sessionId: "session-a" };
  persistence.schedule();
  persistence.persistNow();
  const revision = load(state, state.sessionKey).revisions.latestAttempt;
  const restored = offlineSelection();
  expect(restore(restored)).toBe(true);
  expect(restored.chatGoalDraftMode ?? null).toEqual(state.chatGoalDraftMode ?? null);
  expect(restored.chatReplyTarget ?? null).toEqual(state.chatReplyTarget ?? null);
  state.chatGoalDraftMode = null;
  state.chatReplyTarget = null;
  persistence.schedule();
  persistence.persistNow();
  expect(load(state, state.sessionKey).revisions.latestAttempt).toBeGreaterThan(revision);
  expect(load(state, state.sessionKey).snapshot).toBeNull();
  persistence.stop();
});
