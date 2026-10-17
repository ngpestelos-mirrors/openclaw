import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Context } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import {
  installRuntimeContextMessageForPrompt,
  normalizeMessagesForLlmBoundary,
} from "../../agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { buildRuntimeContextCustomMessage } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { CurrentInboundPromptContext } from "../../agents/internal-runtime-context.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "../../agents/sessions/agent-session-types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { buildReplyPromptEnvelopeBase } from "../../auto-reply/reply/prompt-prelude.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  listSessionPendingInputs,
  loadExactSessionEntryReadOnly,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../server/ws-connection/connect-operator-access.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { bindSteeringTools } from "./chat-send-authority.test-support.js";
import { handleChatSend } from "./chat-send-handler.js";
import {
  setClientProfile,
  setNativeIosClient,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

function hasInputKey(event: unknown, key: string) {
  return isRecord(event) && isRecord(event.message) && event.message.idempotencyKey === key;
}

function steer(
  session: Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[0],
  sessionKey: string,
  ...[text, options, assertCurrent]: Parameters<ReplyBackendMessageInjectionV2["queueMessage"]>
) {
  return steerActiveSessionWithOptionalDeliveryWait(session, text, options, sessionKey, () => {
    assertCurrent();
    return true;
  });
}

describe("steering input custody", () => {
  it.for([
    "shared-secret owner",
    "same grant",
    "changed grant",
    "revoked grant",
    "same permissions across profiles",
    "no native admission across profiles",
    "different scopes across profiles",
    "same role permissions across profiles",
    "different role session caps across profiles",
    "different role agents across profiles",
    "different role sandbox across profiles",
  ] as const)(
    "preserves authenticated chat.send steering authority across callers (%s)",
    async (scenario, { signal }) => {
      const startOwnerTurn = scenario === "same permissions across profiles";
      const sharedSecretOwner = scenario === "shared-secret owner";
      const profile = sharedSecretOwner
        ? ensureGatewayOwnerProfile("Gateway Owner")
        : ensureProfileForEmail("reconnect-steering@example.test");
      const acrossProfiles = scenario.endsWith("across profiles");
      const withRoles = scenario.includes("role");
      const incomingProfile = acrossProfiles
        ? ensureProfileForEmail("other-steering@example.test")
        : profile;
      const fixture = await createBrowserFollowupFixture({
        preserveContent: true,
        active: !startOwnerTurn,
        sandbox: scenario === "different role sandbox across profiles" ? "required" : undefined,
        // Both callers may write here; their caps still differ for other sessions.
        ...(withRoles
          ? { createdActor: { type: "human", source: "profile", id: incomingProfile.id } as const }
          : {}),
      });
      const { scope, context, params: request, beforeApprove } = fixture;
      if (withRoles) {
        const role: GatewayOperatorRoleDefinition = {
          scopes: ["operator.read", "operator.write"],
          sessions: { others: "write" },
          agents: ["main", "other"],
          modelPolicy: { allow: ["openai/gpt-test"] },
        };
        const cfg = context.getRuntimeConfig();
        const overrides: Record<string, Partial<GatewayOperatorRoleDefinition>> = {
          "same role permissions across profiles": {
            agents: ["other", "main"],
            sandbox: "inherit",
          },
          "different role session caps across profiles": { sessions: { others: "view" } },
          "different role agents across profiles": { agents: ["main"] },
          "different role sandbox across profiles": { sandbox: "required" },
        };
        const definitions = { writer: role, participant: { ...role, ...overrides[scenario] } };
        const roleConfig = { ...cfg, gateway: { ...cfg.gateway, roles: { definitions } } };
        context.getRuntimeConfig = () => roleConfig;
        fixture.client.connect.scopes = role.scopes;
        setUserProfileRole(profile.id, "writer");
        setUserProfileRole(incomingProfile.id, "participant");
      }
      const accepted =
        sharedSecretOwner ||
        scenario === "same grant" ||
        scenario === "same permissions across profiles" ||
        scenario === "same role permissions across profiles";
      const queued = !accepted && scenario !== "revoked grant";
      const originalGrant = new AbortController();
      const incomingGrant = new AbortController();
      const client = (connId: string, controller: AbortController, grantId: string) => ({
        ...createOperatorWsClient({ connId, scopes: fixture.client.connect.scopes }),
        usesSharedGatewayAuth: sharedSecretOwner,
        authenticatedUserId: sharedSecretOwner ? undefined : "reconnect-steering@example.test",
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          avatarRevision: "synthetic-avatar",
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        },
        connect: { ...fixture.client.connect, caps: ["ui-commands"] },
        internal: sharedSecretOwner
          ? { authenticatedOperator: true as const, operatorRoleActor: { kind: "system" as const } }
          : {
              operatorAccessAuthority: {
                gatewayAccessGrant: { pluginId: "test-access-policy", grantId },
                signal: controller.signal,
                assertCurrent: () => controller.signal.throwIfAborted(),
              },
            },
      });
      const originalClient = client("original-browser", originalGrant, "original-grant");
      const reconnectedClient = client(
        "reconnected-browser",
        incomingGrant,
        scenario === "changed grant" ? "replacement-grant" : "original-grant",
      );
      if (sharedSecretOwner) {
        prepareGatewayConnectOperatorAccess(originalClient);
        prepareGatewayConnectOperatorAccess(reconnectedClient);
        expect(originalClient.internal.operatorAccessAuthority).toBeUndefined();
        expect(reconnectedClient.internal.operatorAccessAuthority).toBeUndefined();
      }
      if (acrossProfiles) {
        reconnectedClient.authenticatedUserId = "other-steering@example.test";
        reconnectedClient.authenticatedUserProfile = {
          ...reconnectedClient.authenticatedUserProfile,
          profileId: incomingProfile.id,
          updatedAt: incomingProfile.updatedAt,
        };
        if (scenario === "different scopes across profiles") {
          reconnectedClient.connect.scopes = ["operator.read", "operator.write"];
        }
        prepareGatewayConnectOperatorAccess(originalClient);
        prepareGatewayConnectOperatorAccess(reconnectedClient);
        expect(originalClient.internal.operatorAccessAuthority).toBeNull();
        expect(reconnectedClient.internal.operatorAccessAuthority).toBeNull();
      }
      let captured: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
      let operation = fixture.activeRun;
      let ownerContext: CurrentInboundPromptContext | undefined;
      let cleanupOwnerContext = () => {};
      let backingRun: Promise<void> | undefined;
      let releaseProvider = () => {};
      try {
        if (startOwnerTurn) {
          const ownerDispatch = createDispatchTestHarness({
            connId: originalClient.connId,
            buildRequestContext: () => context,
            extraHandlers: { "chat.send": handleChatSend },
          });
          await ownerDispatch.dispatcher.dispatch(
            {
              type: "req",
              id: "owner-input",
              method: "chat.send",
              params: {
                ...request,
                message: "Continue the original work",
                idempotencyKey: "owner-input",
              },
            },
            originalClient,
          );
          await fixture.dispatchedRecorder;
          const ownerDispatchParams = dispatchInboundMessageMock.mock.calls[0]![0] as Parameters<
            typeof dispatchInboundMessage
          >[0];
          const ownerCtx = ownerDispatchParams.ctx;
          expect(ownerCtx).not.toHaveProperty("SenderId");
          ownerContext = buildReplyPromptEnvelopeBase({
            ctx: ownerCtx,
            sessionCtx: ownerCtx,
            baseBody: ownerCtx.BodyForAgent!,
            hasUserBody: true,
            inboundUserContext: buildInboundUserContextPrefix(ownerCtx),
            isBareSessionReset: false,
            startupAction: "new",
          }).currentInboundContext;
          dispatchInboundMessageMock.mockClear();
          operation = createReplyOperation({ ...scope, resetTriggered: false });
        }
        captured = await captureGatewayOperatorRunAuthority({
          client: originalClient,
          context,
        });
        if (!captured || !operation) {
          throw new Error("Expected original operator and active run ownership");
        }
        if (acrossProfiles) {
          expect(captured.authority.gatewayAccessGrant).toBeNull();
          expect(incomingProfile.id).not.toBe(captured.authority.profileId);
        }
        const run = createQueueTestRun({
          prompt: "Continue the original work",
          originatingChannel: "webchat",
        });
        const cfg = context.getRuntimeConfig();
        run.operatorAuthority = captured.authority;
        run.run = {
          ...run.run,
          config: cfg,
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          messageProvider: "webchat",
          chatType: "direct",
          clientCaps: ["ui-commands"],
          gatewayUiCommandTarget: { connId: originalClient.connId, profileId: profile.id },
          traceAuthorized: !withRoles,
          senderIsOwner: resolveCommandAuthorization({
            cfg,
            ctx: resolveChatSendCallerContext(originalClient),
            commandAuthorized: true,
          }).senderIsOwner,
        };
        const toolAuthority = prepareReplyToolAuthority(run);
        await toolAuthority.fingerprintAsync(run.run);
        operation.bindToolAuthoritySnapshot(toolAuthority);
        const fingerprint = operation.bindToolAuthorityRoute(run.run);
        if (sharedSecretOwner) {
          const incoming = await captureGatewayOperatorRunAuthority({
            client: reconnectedClient,
            context,
          });
          if (!incoming) {
            throw new Error("Expected authenticated owner authority");
          }
          const incomingTools = prepareReplyToolAuthority({
            ...run,
            operatorAuthority: incoming.authority,
          });
          try {
            expect(incoming.authority.source).not.toBe(captured.authority.source);
            expect(await incomingTools.fingerprintAsync(run.run)).toBe(fingerprint);
          } finally {
            incomingTools.close();
            incoming.release();
          }
        }
        operation.setPhase("running");
        const sessionManager = SessionManager.open(scope, path.dirname(scope.storePath));
        guardSessionManager(sessionManager, { ...scope, runId: "original-backing-run" });
        const { session } = await createTestSession({ sessionManager });
        const convertToLlm = session.agent.convertToLlm.bind(session.agent);
        session.agent.convertToLlm = (messages) =>
          convertToLlm(
            normalizeMessagesForLlmBoundary(messages, {
              sessionVersion: sessionManager.getHeader()?.version,
            }),
          );
        const providerStarted = createDeferred();
        const provider = holdAssistantResponse("Original work");
        streamMocks.streamSimple
          .mockImplementationOnce(() => {
            providerStarted.resolve();
            return provider.response;
          })
          .mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "Steering consumed" }]),
            ),
          );
        releaseProvider = provider.release;
        cleanupOwnerContext = installRuntimeContextMessageForPrompt({
          session,
          message: buildRuntimeContextCustomMessage(ownerContext?.text, ownerContext?.fragments),
          persistedUserIdempotencyKey: startOwnerTurn ? "owner-input:user" : undefined,
        });
        backingRun = session.prompt("Continue the original work", {
          persistedUserIdempotencyKey: startOwnerTurn ? "owner-input:user" : undefined,
        });
        await providerStarted.promise;
        if (startOwnerTurn) {
          const firstContext = streamMocks.streamSimple.mock.calls[0]![1] as Context;
          const ownerUserContext = JSON.stringify(
            firstContext.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content),
          );
          expect(ownerUserContext).toContain("requester_profile");
          expect(ownerUserContext).toContain(profile.id);
          expect(ownerUserContext).not.toContain(incomingProfile.id);
        }
        beforeApprove.mockClear();
        const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
          async (text, options, assertCurrent) =>
            steer(session, scope.sessionKey, text, options, assertCurrent),
        );
        operation.attachBackend({
          kind: "embedded",
          runId: "original-backing-run",
          toolAuthorityFingerprint: fingerprint,
          supportsCrossProfileSteering:
            scenario !== "same grant" && scenario !== "no native admission across profiles",
          cancel: vi.fn(),
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
        });
        const dispatch = createDispatchTestHarness({
          connId: reconnectedClient.connId,
          buildRequestContext: () => context,
          extraHandlers: { "chat.send": handleChatSend },
        });
        if (scenario === "revoked grant") {
          beforeApprove.mockImplementation(() =>
            incomingGrant.abort(new Error("Access grant ended")),
          );
        }
        await dispatch.dispatcher.dispatch(
          {
            type: "req",
            id: "reconnected-input",
            method: "chat.send",
            params: { ...request, queueMode: "steer" },
          },
          reconnectedClient,
        );
        if (accepted || queued) {
          expect(dispatch.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        }
        if (accepted) {
          expect(session.getSteeringMessages()).toEqual([expect.stringContaining(request.message)]);
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          if (acrossProfiles) {
            const inboundContext = queueMessage.mock.calls[0]?.[1]?.currentInboundContext?.text;
            expect(inboundContext).toContain('"requester_profile"');
            const conversationInfo = JSON.parse(
              inboundContext!.match(/```json\n([\s\S]*?)\n```/u)![1]!,
            ) as {
              requester_profile: { id: string };
            };
            expect(conversationInfo.requester_profile.id).toBe(incomingProfile.id);
            expect(
              operation.personalToolParticipants?.resolve(incomingProfile.id)
                ?.gatewayUiCommandTarget,
            ).toEqual({
              connId: reconnectedClient.connId,
              profileId: incomingProfile.id,
            });
          }
        } else {
          expect(session.getSteeringMessages()).toEqual([]);
          expect(queueMessage).not.toHaveBeenCalled();
          if (queued) {
            await withinTest(fixture.dispatchedRecorder, signal);
            expect(operation.personalToolParticipants?.resolve()?.profileId).toBe(profile.id);
            expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock.mock.calls[0]?.[0]).toMatchObject({
              replyOptions: { messageInjectionDisposition: "rejected" },
            });
            expect(await listSessionPendingInputs(scope)).toMatchObject({
              total: 1,
              items: [{ runId: request.idempotencyKey, state: "queued" }],
            });
          } else {
            expect(beforeApprove).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          }
        }
        releaseProvider();
        await backingRun;
        await fixture.finishDispatch();
        const input = loadTranscriptEventsSync(scope).find((event) =>
          hasInputKey(event, `${request.idempotencyKey}:user`),
        );
        if (accepted) {
          expect(input).toMatchObject({
            message: {
              content: request.message,
              __openclaw: { steerTargetRunId: "original-backing-run" },
            },
          });
          expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
          if (acrossProfiles) {
            const modelContext = streamMocks.streamSimple.mock.calls[1]![1] as Context;
            const steeredUserIndex = modelContext.messages.findLastIndex(
              (message) => message.role === "user" && !Reflect.get(message, "runtimeContext"),
            );
            const steeredUser = modelContext.messages[steeredUserIndex];
            const runtimeContext = modelContext.messages[steeredUserIndex - 1];
            const userText = JSON.stringify(steeredUser?.content);
            const runtimeText = JSON.stringify(runtimeContext?.content);
            expect(runtimeText).toContain("requester_profile");
            expect(runtimeText).toContain(incomingProfile.id);
            expect(runtimeText).not.toContain(profile.id);
            expect(userText).not.toContain("requester_profile");
          }
        } else if (queued) {
          expect(input).toMatchObject({ message: { content: request.message } });
          expect(input).not.toHaveProperty("message.__openclaw.steerTargetRunId");
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        } else {
          expect(input).toBeUndefined();
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        }
      } finally {
        try {
          releaseProvider();
          await backingRun;
        } finally {
          cleanupOwnerContext();
          operation?.complete();
          try {
            await fixture.cleanup();
          } finally {
            captured?.release();
          }
        }
      }
      assertNoRetainedSessionSharingReads();
    },
  );

  it.each([
    "internal fresh",
    "native custody",
    "native committed",
    "browser custody",
    "browser custody workspace",
    "browser custody session ACL",
    "browser custody lifecycle",
  ] as const)(
    "owns the real backing-run outcome when authority changes at steering commit (%s)",
    async (inputState) => {
      const sharedProfileCustody =
        inputState === "browser custody" ||
        inputState === "browser custody workspace" ||
        inputState === "browser custody session ACL";
      const creator = sharedProfileCustody
        ? ensureProfileForEmail("steering-session-creator@example.test")
        : undefined;
      const fixture = await createBrowserFollowupFixture({
        preserveContent: true,
        ...(creator
          ? { createdActor: { type: "human", source: "profile", id: creator.id } as const }
          : {}),
      });
      const { scope, context, params: request, beforeApprove } = fixture;
      let releaseProviders = () => {};
      let backingRun: Promise<void> | undefined;
      const run = async () => {
        if (inputState === "browser custody workspace") {
          await patchSessionEntryCore(scope, () => ({
            pendingProjectGitUrl: "file:///synthetic/missing-project.git",
          }));
        }
        const browserCustody = sharedProfileCustody || inputState === "browser custody lifecycle";
        request.queueMode = "steer";
        const operation = fixture.activeRun;
        if (!operation) {
          throw new Error("Expected a captured backing run");
        }
        const email = "steering-commit@example.test";
        const profile = ensureProfileForEmail(email);
        const target = ensureProfileForEmail("steering-commit-target@example.test");
        if (creator) {
          expect(profile.id).not.toBe(creator.id);
          expect(target.id).not.toBe(creator.id);
          fixture.client.connect.scopes = ["operator.read", "operator.write"];
          await patchSessionEntryCore(scope, () => ({
            visibility: "shared",
          }));
          expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: creator.id },
          });
        }
        if (!browserCustody) {
          setNativeIosClient(fixture.client);
        }
        if (inputState === "internal fresh") {
          request.systemInputProvenance = {
            kind: "internal_system",
            sourceTool: "internal-steering-fixture",
          };
        }
        setClientProfile(fixture.client, profile);
        const sessionManager = SessionManager.open(scope, path.dirname(scope.storePath));
        const inputKey = `${request.idempotencyKey}:user`;
        let recorder: UserTurnTranscriptRecorder | undefined;
        let initialRuntimeReceipt: ReturnType<UserTurnTranscriptRecorder["getAdmissionReceipt"]>;
        guardSessionManager(sessionManager, {
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          runId: "native-backing-run",
          onUserMessagePersisted: (message) => {
            if ("idempotencyKey" in message && message.idempotencyKey === inputKey) {
              initialRuntimeReceipt = structuredClone(recorder?.getAdmissionReceipt());
            }
          },
        });
        const { session } = await createTestSession({ sessionManager });
        const terminals: AgentSessionEvent[] = [];
        session.subscribe((event) => {
          if (event.type === "agent_end" || event.type === "agent_settled") {
            terminals.push(event);
          }
        });
        const backingProvider = holdAssistantResponse("backing answer");
        const steeringProvider = holdAssistantResponse("accepted steering completed");
        streamMocks.streamSimple
          .mockImplementationOnce(() => backingProvider.response)
          .mockImplementation((model) =>
            inputState === "native committed"
              ? steeringProvider.response
              : createAssistantResultStream(
                  createAssistant(model, [{ type: "text", text: "accepted steering completed" }]),
                ),
          );
        releaseProviders = () => {
          backingProvider.release();
          steeringProvider.release();
        };
        backingRun = session.prompt("Continue the original backing work.");
        const cancel = vi.fn();
        const fingerprint = "steering-commit-tools";
        bindSteeringTools(operation, fingerprint);
        operation.setPhase("running");
        operation.attachBackend({
          kind: "embedded",
          runId: "native-backing-run",
          toolAuthorityFingerprint: fingerprint,
          cancel,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async (text, options, assertCurrent) => {
              recorder = options?.userTurnTranscriptRecorder;
              return await steer(session, scope.sessionKey, text, options, assertCurrent);
            },
          },
        });
        await vi.waitFor(() => expect(streamMocks.streamSimple).toHaveBeenCalledOnce());
        const ack = await fixture.send(undefined, { expectedProfileId: profile.id });
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        expect(ack).toHaveBeenCalledOnce();
        const originalAck = structuredClone(ack.mock.calls);
        expect(recorder).toBeDefined();
        if (!recorder) {
          throw new Error("The backing runtime did not capture its input recorder");
        }
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
        const persistFallback = vi.spyOn(recorder, "persistFallback");
        const pending = await listSessionPendingInputs(scope);
        expect(pending.total).toBe(inputState === "internal fresh" ? 0 : 1);
        expect(
          beforeApprove.mock.calls.filter(
            ([message]) => "idempotencyKey" in message && message.idempotencyKey === inputKey,
          ),
        ).toHaveLength(inputState === "internal fresh" ? 0 : 1);
        beforeApprove.mockClear();
        if (
          sharedProfileCustody ||
          inputState === "native custody" ||
          inputState === "browser custody lifecycle"
        ) {
          expect(session.getSteeringMessages()).toEqual([request.message]);
          expect(session.isStreaming).toBe(true);
          expect(backingProvider.isReleased()).toBe(false);
          expect(pending.items[0]).toMatchObject({
            runId: request.idempotencyKey,
            state: "queued",
            message: { idempotencyKey: inputKey, content: request.message },
          });
        }
        if (sharedProfileCustody || inputState === "native custody") {
          linkEmail(email, target.id);
          if (inputState === "browser custody session ACL") {
            await initializeSessionReadContext(context);
            const visibility = {
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              visibility: "draft",
            };
            const respond = vi.fn<RespondFn>();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: "revoke-steering-session-access",
                method: "session.visibility.set",
                params: visibility,
              },
              client: identifiedClient(creator!.id),
              context,
              isWebchatConnect: () => true,
              respond,
            });
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              { ok: true, sessionKey: scope.sessionKey, visibility: "draft" },
              undefined,
            );
            expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: creator!.id },
            });
            expect(operation.result).toBeNull();
            expect(backingProvider.isReleased()).toBe(false);
          }
        } else if (inputState === "browser custody lifecycle") {
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          rotateAgentEventLifecycleGeneration();
          expect(cancel).toHaveBeenCalledExactlyOnceWith("restart");
          expect(operation.result).toMatchObject({
            kind: "aborted",
            code: "aborted_for_restart",
          });
        } else if (inputState === "internal fresh") {
          beforeApprove.mockImplementation(() => linkEmail(email, target.id));
        }
        backingProvider.release();
        if (inputState === "native committed") {
          await vi.waitFor(() => expect(initialRuntimeReceipt).toBeDefined());
          // Source finalization confirms steering metadata after the runtime commit.
          // Keep the backing provider held until that final receipt is observable.
          await vi.waitFor(() =>
            expect(context.dedupe.get(`chat:${request.idempotencyKey}`)).toMatchObject({
              ok: true,
              payload: { runId: request.idempotencyKey, status: "ok" },
            }),
          );
          const finalReceipt = structuredClone(recorder.getAdmissionReceipt());
          const committedTranscript = loadTranscriptEventsSync(scope);
          expect(finalReceipt).toBeDefined();
          expect(operation.result).toBeNull();
          expect(session.isStreaming).toBe(true);
          expect(beforeApprove).not.toHaveBeenCalled();
          linkEmail(email, target.id);
          expect(await recorder.persistApproved()).toBeUndefined();
          expect(recorder.getAdmissionReceipt()).toEqual(finalReceipt);
          expect(loadTranscriptEventsSync(scope)).toEqual(committedTranscript);
          expect(beforeApprove).not.toHaveBeenCalled();
          steeringProvider.release();
        }
        await backingRun;
        await fixture.finishDispatch();
        const revoked =
          inputState === "browser custody lifecycle" ||
          inputState === "browser custody session ACL";
        const refused = inputState === "internal fresh";
        const failed = revoked || refused;
        const transcript = loadTranscriptEventsSync(scope);
        const originalInputs = transcript.filter(
          (entry) => isRecord(entry) && entry.type === "message" && hasInputKey(entry, inputKey),
        );
        const cached = structuredClone(context.dedupe.get(`chat:${request.idempotencyKey}`));
        expect(ack.mock.calls).toEqual(originalAck);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(cancel.mock.calls).toEqual(
          inputState === "browser custody lifecycle" ? [["restart"]] : [],
        );
        expect(session.isStreaming).toBe(false);
        expect(session.getSteeringMessages()).toEqual([]);
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(failed ? 1 : 2);
        expect(
          beforeApprove.mock.calls.map(([message]) =>
            "idempotencyKey" in message ? message.idempotencyKey : undefined,
          ),
        ).toEqual(refused ? [inputKey, inputKey] : []);
        expect(originalInputs).toHaveLength(failed ? 0 : 1);
        expect(cached).toMatchObject({
          ok: !failed,
          payload: { runId: request.idempotencyKey, status: failed ? "error" : "ok" },
        });
        expect([context.chatAbortControllers.size, context.chatQueuedTurns.size]).toEqual([0, 0]);
        if (failed) {
          expect(recorder.getAdmissionReceipt()).toBeUndefined();
          expect(transcript).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "assistant",
                stopReason: "error",
                __openclaw: expect.objectContaining({ runId: "native-backing-run" }),
              }),
            }),
          );
        }
        if (revoked) {
          const sessionRevoked = inputState === "browser custody session ACL";
          const sourceError = expect.stringContaining(
            sessionRevoked
              ? "session is draft for this connection"
              : "Pending input ownership ended",
          );
          expect(terminals.map((event) => event.type)).toEqual(["agent_end", "agent_settled"]);
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "error",
            errorMessage: sessionRevoked
              ? expect.stringContaining("Message injection authority is no longer current")
              : sourceError,
          });
          expect(cached).toMatchObject({ error: { message: sourceError } });
          expect(
            vi
              .mocked(context.broadcast)
              .mock.calls.filter(
                ([event, payload]) =>
                  event === "chat" &&
                  isRecord(payload) &&
                  payload.runId === request.idempotencyKey &&
                  payload.state === "error",
              )
              .map(([, payload]) => payload),
          ).toMatchObject([
            {
              runId: request.idempotencyKey,
              state: "error",
              errorMessage: sourceError,
            },
          ]);
          expect(await listSessionPendingInputs(scope)).toMatchObject({
            total: 1,
            items: [{ ...pending.items[0], state: "interrupted" }],
          });
        } else {
          expect(terminals.filter((event) => event.type === "agent_end")).toHaveLength(1);
          expect(terminals.filter((event) => event.type === "agent_settled")).toHaveLength(1);
          if (refused) {
            expect(persistFallback).toHaveBeenCalledOnce();
            // Memory consumption precedes persistence; refusal terminates the backing run.
            expect(session.messages).toContainEqual(
              expect.objectContaining({
                role: "user",
                content: expect.arrayContaining([
                  expect.objectContaining({ type: "text", text: request.message }),
                ]),
              }),
            );
            expect(session.messages.at(-1)).toMatchObject({
              role: "assistant",
              stopReason: "error",
              errorMessage: expect.any(String),
            });
            expect(context.broadcast).toHaveBeenCalledWith(
              "chat",
              expect.objectContaining({
                runId: request.idempotencyKey,
                state: "error",
                errorMessage: expect.stringContaining("Selected account changed"),
              }),
              expect.anything(),
            );
          } else {
            expect(session.messages.at(-1)).toMatchObject({
              role: "assistant",
              stopReason: "stop",
            });
            expect(recorder.getAdmissionReceipt()).toBeDefined();
          }
          if (inputState === "browser custody workspace") {
            expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
              pendingProjectGitUrl: "file:///synthetic/missing-project.git",
            });
          }
          const staleRetry = await fixture.send(undefined, { expectedProfileId: profile.id });
          expect(staleRetry).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
            }),
          );
          expect(context.dedupe.get(`chat:${request.idempotencyKey}`)).toEqual(cached);
          expect(loadTranscriptEventsSync(scope)).toEqual(transcript);
          expect([context.chatAbortControllers.size, context.chatQueuedTurns.size]).toEqual([0, 0]);
          expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
        }
      };
      await runQaGatewayFixture(
        run,
        () => {
          releaseProviders();
          return backingRun;
        },
        fixture.cleanup,
      );
    },
  );
});
