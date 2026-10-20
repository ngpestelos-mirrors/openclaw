/* @vitest-environment jsdom */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import * as drafts from "../../lib/chat/composer-draft-store.runtime.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { restorePaneStagedAttachments } from "./chat-pane-attachment-handoff.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  loadChatComposerState,
} from "./composer-persistence.ts";

afterEach(vi.restoreAllMocks);
it("keeps A offline input with A when a same-client B hello replaces the pane before recovery settles", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const prepare = vi.spyOn(drafts, "prepareDurableComposerRecovery");
  prepare.mockResolvedValue({ status: "ready", entries: [] });
  const read = vi.spyOn(drafts, "readDurableComposerDraft");
  read.mockResolvedValue({ status: "not-found", revision: 0 });
  const write = vi.spyOn(drafts, "writeDurableComposerDraft");
  write.mockResolvedValue({ status: "persisted" });
  const writesFor = (owner: string) =>
    write.mock.calls.filter(([scope]) => scope.recoveryScope === owner).map(([, draft]) => draft);
  const privateDraft = "A newer private draft";
  let account = "account-a";
  let ready = false;
  const client = createTestGatewayClient(async () => ({}));
  vi.spyOn(client, "recoveryScope", "get").mockImplementation(() => account);
  vi.spyOn(client, "offlineRecoveryScope", "get").mockImplementation(() => account);
  vi.spyOn(client, "recoveryScopeReady", "get").mockImplementation(() => ready);
  const { pane, state } = createTestChatPane({ client });
  Object.assign(pane, { paneId: "p1", stagedAttachmentGatewayOwner: client });
  state.settings = pane.context.gateway.connection;
  state.chatMessage = "A offline draft";
  state.connected = false;
  pane.chatState.attach(state);
  const persistence = pane.chatState.composerPersistence;
  persistence.start();
  await settle();
  ready = true;
  state.connected = true;
  persistence.persistChangedState();
  ready = false;
  state.connected = false;
  expect(
    admitStoredChatComposerQueueItem(state, captureChatOutboxAdmission(state, state.sessionKey), {
      id: "a-queue",
      text: "A queued work",
      createdAt: 1,
    }),
  ).toBe(true);
  state.chatMessage = privateDraft;
  state.chatAttachments = [
    { id: "a", mimeType: "text/plain", dataUrl: "data:text/plain;base64,QQ==" },
  ];
  persistence.schedule();
  persistence.persistNow();
  await settle();
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.draft).toBe(privateDraft);
  // Identity changes before hello observers; A can unmount before recovery is ready.
  account = "account-b";
  pane.context.gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [], recoveryScope: account },
  };
  pane.disconnectedCallback();
  ready = true;
  const destination = {
    ...state,
    client,
    connected: true,
    chatMessage: "",
    chatAttachments: [] as ChatAttachment[],
    chatQueue: [],
  };
  restorePaneStagedAttachments(pane.context, "p1", destination, client);
  const b = new ChatComposerPersistence(() => destination);
  b.start();
  b.persistChangedState();
  await settle();
  expect(destination).toMatchObject({ chatMessage: "", chatAttachments: [] });
  expect(loadChatComposerState(destination, destination.sessionKey).snapshot?.draft ?? "").toBe("");
  const bWrites = writesFor("account-b");
  expect(bWrites.some((d) => d.text.includes("A newer") || d.attachments.length)).toBe(false);
  account = "account-a";
  expect(loadChatComposerState(destination, destination.sessionKey).snapshot).toMatchObject({
    draft: privateDraft,
    queue: [{ id: "a-queue" }],
  });
  const aWrites = writesFor("account-a");
  expect(aWrites.some((d) => d.text === privateDraft && d.attachments.length === 1)).toBe(true);
  b.stop();
});
