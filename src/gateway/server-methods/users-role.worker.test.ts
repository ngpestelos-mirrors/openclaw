import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  readResidentUserProfileIdentity,
  prepareUserProfileCatalog,
} from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { usersHandlers } from "./users.js";

const boundary = vi.hoisted(() => ({
  afterRoleResult: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      ...[context, operation, options]: Parameters<typeof actual.runOpenClawStateWorkerOperation>
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.setRole") {
                await boundary.afterRoleResult?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});

let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
let release: (() => void) | undefined;
beforeEach(() => resetGatewayWorkAdmission());
afterEach(async () => {
  boundary.afterRoleResult = undefined;
  vi.restoreAllMocks();
  release?.();
  release = undefined;
  await state?.cleanup();
});

function roleConfig(): OpenClawConfig {
  return {
    gateway: {
      roles: {
        definitions: {
          administrator: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
        },
      },
    },
  };
}

function profileClient(
  profileId: string,
  connId: string,
  close: ReturnType<typeof vi.fn>,
): GatewayWsClient {
  return {
    ...createOperatorWsClient({ connId, socket: { close } }),
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function roleHarness(
  client: GatewayWsClient,
  clients = new GatewayClientRegistry([client]),
  overrides: Parameters<typeof createDirectChatContext>[0] = {},
) {
  const owner = createGatewayRequestContext(makeContextParams({ clients }));
  const context = createDirectChatContext({
    getRuntimeConfig: roleConfig,
    isConnectionActive: (connId) => [...clients].some((entry) => entry.connId === connId),
    getClientConnIds: owner.getClientConnIds,
    disconnectClientsForUserProfile: owner.disconnectClientsForUserProfile,
    ...overrides,
  });
  return createDispatchTestHarness({
    connId: client.connId,
    getRequiredSharedGatewaySessionGeneration: new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: null,
    }).reader,
    buildRequestContext: () => context,
    extraHandlers: usersHandlers,
  });
}

function roleRequest(profileId: string, expectedProfileId?: string) {
  return {
    type: "req" as const,
    id: "role",
    method: "users.setRole",
    params: { profileId, role: "reader" },
    ...(expectedProfileId === undefined ? {} : { expectedProfileId }),
  };
}

function roleError(code: string, message: string) {
  return {
    ok: false,
    error: expect.objectContaining({ code, message: expect.stringContaining(message) }),
  };
}

it.each(["failed delivery", "self downgrade"] as const)(
  "retires role policy and connections through %s",
  async (scenario) => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "users-role-delivery-",
      prepareProfileCatalog: true,
    });
    const requester = ensureProfileForEmail("administrator@example.test");
    setUserProfileRole(requester.id, "administrator");
    const target = ensureProfileForEmail("reader@example.test");
    setUserProfileRole(target.id, "administrator");
    const changed = scenario === "self downgrade" ? requester : target;
    release = (await prepareUserProfileCatalog()).release;
    expect(resolveOperatorRolePolicyForProfile(changed.id, roleConfig())?.scopes).toEqual([
      "operator.admin",
    ]);
    const clientClose = vi.fn();
    const targetClose = vi.fn();
    const client = profileClient(requester.id, "role-requester", clientClose);
    const targetClient = profileClient(target.id, "role-target", targetClose);
    const harness = roleHarness(client, new GatewayClientRegistry([client, targetClient]));
    if (scenario === "failed delivery") {
      boundary.afterRoleResult = async () => {
        throw new Error("synthetic committed role delivery failure");
      };
    }
    await harness.dispatcher.dispatch(roleRequest(changed.id, requester.id), client);
    expect(readResidentUserProfileIdentity(changed.id)?.role).toBe("reader");
    expect(resolveOperatorRolePolicyForProfile(changed.id, roleConfig())?.scopes).toEqual([
      "operator.read",
    ]);
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "role",
        ...(scenario === "self downgrade"
          ? {
              ok: true,
              payload: expect.objectContaining({
                profile: expect.objectContaining({ id: requester.id, role: "reader" }),
              }),
            }
          : roleError("UNAVAILABLE", "synthetic committed role delivery failure")),
      }),
    );
    expect(scenario === "self downgrade" ? clientClose : targetClose).toHaveBeenCalledOnce();
    expect(scenario === "self downgrade" ? targetClose : clientClose).not.toHaveBeenCalled();
  },
);

it("preserves the cold missing-profile RPC error without disconnecting a client", async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "users-role-cold-" });
  const client: GatewayWsClient = {
    ...createOperatorWsClient({ connId: "cold-role-requester", socket: { close: vi.fn() } }),
    usesSharedGatewayAuth: true,
    sharedGatewaySessionGeneration: "generation-a",
    internal: { operatorRoleActor: { kind: "system" } },
  };
  const disconnectClientsForUserProfile = vi.fn();
  const harness = roleHarness(client, undefined, {
    disconnectClientsForUserProfile,
  });
  expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
  await harness.dispatcher.dispatch(roleRequest("missing-cold-profile"), client);
  expect(harness.send).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "role",
      ...roleError("INVALID_REQUEST", "user profile not found"),
    }),
  );
  expect(disconnectClientsForUserProfile).not.toHaveBeenCalled();
});
