import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  upsertSessionEntryCore,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import * as store from "../operator-approval-store.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { canAccessApprovalSession } from "./approval-record-lookup.js";
import { createApprovalHandlers } from "./approval.js";
import {
  createApprovalInvocation,
  createClient,
  createContext,
  getOperatorApproval,
} from "./approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import {
  callSessionSharingHandler,
  identifiedClient,
  sessionSharingTestContext,
} from "./sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each(
  (["approval.resolve", "exec.approval.resolve"] as const).flatMap((method) =>
    (["visibility", "membership"] as const).map((change) => ({ method, change })),
  ),
)(
  "retains the actual sharing publisher's revocation during $method ($change)",
  async ({ method, change }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const profile = roleClient("none", "approval-sharing");
      const profileId = profile.authenticatedUserProfile!.profileId;
      const sessionKey = "agent:main:approval-sharing";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "sharing-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: profileId },
      });
      await addSessionMember(scope, { identityId: "other-member", addedBy: profileId });
      const beforeSession = loadSessionEntry(scope);
      const databaseOptions = { env: state.env };
      const persistence = { runtimeEpoch: "sharing-custody", databaseOptions };
      const manager = new ExecApprovalManager({ persistence });
      const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
        persistence,
        approvalKind: "plugin",
      });
      const record = manager.create(
        { command: "echo sharing", agentId: "main", sessionKey },
        600_000,
      );
      record.approvalReviewerDeviceIds = ["reviewer"];
      const { decision } = await manager.register(record, 600_000);
      const settled = vi.fn();
      void decision.then(settled, () => undefined);
      const client = createClient({ deviceId: "reviewer" });
      client.authenticatedUserId = profile.authenticatedUserId;
      const profileBinding = expectDefined(profile.authenticatedUserProfile, "reviewer profile");
      client.authenticatedUserProfile = {
        ...profileBinding,
        avatarRevision: profileBinding.avatarRevision ?? "synthetic-avatar",
      };
      client.preparedSessionProfile = profile.preparedSessionProfile;
      const context = createContext();
      context.getRuntimeConfig = () => cfg;
      const entered = createDeferred();
      const release = createDeferred();
      const resolve = store.resolveOperatorApproval;
      vi.spyOn(store, "resolveOperatorApproval").mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        return resolve(params);
      });
      const invocation = createApprovalInvocation({
        method,
        client,
        context,
        handlers:
          method === "approval.resolve"
            ? createApprovalHandlers({
                execApprovalManager: manager,
                pluginApprovalManager: plugin,
                databaseOptions,
              })
            : createExecApprovalHandlers(manager),
        body: {
          id: record.id,
          ...(method === "approval.resolve" ? { kind: "exec" } : {}),
          decision: "allow-once",
        },
      });
      const pending = invocation.invoke();
      try {
        await Promise.race([
          entered.promise,
          pending.then((response) => {
            throw new Error("Approval did not reach verdict: " + JSON.stringify(response.error));
          }),
        ]);
        const revision = readGatewayAccessRevision();
        const responses = await callSessionSharingHandler(
          change === "visibility" ? "session.visibility.set" : "session.members.remove",
          {
            sessionKey,
            ...(change === "visibility"
              ? { visibility: "read-only" }
              : { identityId: "other-member" }),
          },
          sessionSharingTestContext(vi.fn(), cfg),
          identifiedClient(profileId),
        );
        expect(responses[0]?.[0]).toBe(true);
        expect(readGatewayAccessRevision()).toBeGreaterThan(revision);
        expect(loadSessionEntry(scope)?.sessionId).toBe(beforeSession?.sessionId);
        release.resolve();
        expect(await pending).toMatchObject({ ok: false });
        expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
          status: "pending",
          decision: null,
        });
        expect(settled).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        await Promise.all([manager.drain(), plugin.drain()]);
      }
    });
  },
);

it("does not treat ordinary membership or sharing changes as a creator-only approval access revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const creator = roleClient("none", "creator");
    const member = roleClient("none", "member");
    const reader = roleClient("view", "reader");
    const sessionKey = "agent:main:sharing-policy";
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId: "policy-session",
      updatedAt: 1,
      visibility: "shared",
      createdActor: {
        type: "human",
        source: "profile",
        id: creator.authenticatedUserProfile!.profileId,
      },
    });
    const allowed = (client: typeof creator) =>
      canAccessApprovalSession({ cfg, client, sessionKey, agentId: "main" });
    await addSessionMember(scope, {
      identityId: member.authenticatedUserProfile!.profileId,
      addedBy: creator.authenticatedUserProfile!.profileId,
    });
    expect([allowed(creator), allowed(member), allowed(reader)]).toEqual([true, false, true]);
    const revision = readGatewayAccessRevision();
    await removeSessionMember(scope, member.authenticatedUserProfile!.profileId);
    expect(readGatewayAccessRevision()).toBe(revision);
    expect([allowed(creator), allowed(member), allowed(reader)]).toEqual([true, false, true]);
  });
});
