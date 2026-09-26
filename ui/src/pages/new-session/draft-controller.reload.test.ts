/* @vitest-environment jsdom */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  canReloadControlUiDocument,
  registerControlUiReloadGuard,
} from "../../app/document-reload-guard.ts";
import { getChatAttachmentDataUrl } from "../chat/attachment-payload-store.ts";
import { NewSessionDraftController } from "./draft-controller.ts";
import { createDraftFixture, registerTextPayload } from "./draft-submission-flow.test-support.ts";

const recovery = vi.hoisted(() => ({
  review: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn<(options: { onAction?: () => void }) => boolean>(() => true),
  reload: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("../chat/components/private-composer-recovery-dialog.ts", () => ({
  reviewPrivateComposerDraft: recovery.review,
}));
vi.mock("../../lib/toast.ts", () => ({ showToast: recovery.toast }));
vi.mock("../../app/stale-chunk-reload.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/stale-chunk-reload.ts")>()),
  retryStaleChunkReloadWhenReachable: recovery.reload,
}));

afterEach(() => vi.clearAllMocks());

it.each(["keep", "discard", "new edit", "new connection", "disconnect", "other guard"] as const)(
  "protects the mounted New Session draft through %s",
  async (scenario) => {
    const fixture = createDraftFixture();
    const { context } = fixture;
    const controllers = new Set<ReactiveController>();
    const host: ReactiveControllerHost = {
      addController: (controller) => void controllers.add(controller),
      removeController: (controller) => void controllers.delete(controller),
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
    };
    let connected = true;
    const controller = new NewSessionDraftController(
      host,
      () => ({ context, data: undefined, isConnected: connected }),
      {
        requestUpdate: () => undefined,
        closeTransientUi: () => undefined,
        querySelector: () => null,
        activeElement: () => null,
        body: () => null,
        onInvalidate: () => undefined,
        onRecoveryReady: () => undefined,
      },
    );
    for (const owned of controllers) {
      owned.hostConnected?.();
    }
    const draft = controller.submission;
    const attachment = registerTextPayload("synthetic-private-start");
    draft.setVisibility("incognito");
    draft.setMessage("Private unsent text");
    draft.attachmentDraft.replace([attachment]);
    const pending = createDeferred<boolean>();
    recovery.review.mockReturnValue(pending.promise);
    recovery.reload.mockImplementation(async () => canReloadControlUiDocument());
    const releaseOther =
      scenario === "other guard"
        ? registerControlUiReloadGuard(
            () => false,
            () => undefined,
          )
        : () => undefined;
    try {
      expect(canReloadControlUiDocument(true)).toBe(false);
      recovery.toast.mock.lastCall?.[0].onAction?.();
      expect(recovery.review).toHaveBeenCalledOnce();
      if (scenario === "new edit") {
        draft.setMessage("Newer private input");
      } else if (scenario === "new connection") {
        Object.assign(context.gateway, { connection: { ...context.gateway.connection } });
      } else if (scenario === "disconnect") {
        connected = false;
        for (const owned of controllers) {
          owned.hostDisconnected?.();
        }
      }
      pending.resolve(scenario !== "keep");
      await pending.promise;
      const discarded = scenario === "discard" || scenario === "other guard";
      expect(draft.message).toBe(
        discarded ? "" : scenario === "new edit" ? "Newer private input" : "Private unsent text",
      );
      expect(draft.attachmentDraft.attachments).toEqual(discarded ? [] : [attachment]);
      expect(getChatAttachmentDataUrl(attachment) === null).toBe(discarded);
      expect(recovery.reload).toHaveBeenCalledTimes(discarded ? 1 : 0);
      if (discarded) {
        expect(await recovery.reload.mock.results[0]?.value).toBe(scenario === "discard");
      }
    } finally {
      releaseOther();
      for (const owned of controllers) {
        owned.hostDisconnected?.();
      }
      controller.disconnect();
      fixture.flow.disconnect();
      fixture.gateway.disconnect();
    }
    expect(canReloadControlUiDocument()).toBe(true);
  },
);
