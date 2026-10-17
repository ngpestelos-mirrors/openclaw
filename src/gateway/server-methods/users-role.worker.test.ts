import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
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
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { usersHandlers } from "./users.js";

const boundary = vi.hoisted(() => ({ failRole: false }));
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
              if (boundary.failRole && command.type === "userProfiles.setRole") {
                throw new Error("synthetic committed role delivery failure");
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
  boundary.failRole = false;
  vi.restoreAllMocks();
  release?.();
  release = undefined;
  await state?.cleanup();
});

const definitions = {
  administrator: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
  reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
} satisfies Record<string, GatewayOperatorRoleDefinition>;
const roleConfig = () => ({ gateway: { roles: { definitions } } });

function profileClient(profileId: string | undefined, close: ReturnType<typeof vi.fn>) {
  const client = createOperatorWsClient({ connId: profileId ?? "cold", socket: { close } });
  if (profileId) {
    client.authenticatedUserProfile = {
      profileId,
      displayName: null,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: 1,
    };
  } else {
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = "generation-a";
    client.internal = { operatorRoleActor: { kind: "system" } };
  }
  return client;
}

it.each(["failed delivery", "self downgrade", "cold missing profile"] as const)(
  "preserves role mutation and connection policy through %s",
  async (scenario) => {
    const cold = scenario === "cold missing profile";
    const self = scenario === "self downgrade";
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "users-role-",
      prepareProfileCatalog: !cold,
    });
    const requester = cold ? undefined : ensureProfileForEmail("administrator@example.test");
    const target = cold ? undefined : ensureProfileForEmail("reader@example.test");
    const changedId = (self ? requester : target)?.id ?? "missing-cold-profile";
    const scopes = () => resolveOperatorRolePolicyForProfile(changedId, roleConfig())?.scopes;
    if (requester && target) {
      for (const person of [requester, target]) {
        setUserProfileRole(person.id, "administrator");
      }
      release = (await prepareUserProfileCatalog()).release;
      expect(scopes()).toEqual(["operator.admin"]);
    }
    const clientClose = vi.fn();
    const targetClose = vi.fn();
    const client = profileClient(requester?.id, clientClose);
    const clients = new GatewayClientRegistry([client]);
    if (target) {
      clients.add(profileClient(target.id, targetClose));
    }
    const disconnect = vi.fn();
    const context = createGatewayRequestContext(
      makeContextParams({
        clients,
        isConnectionActive: (connId) => [...clients].some((entry) => entry.connId === connId),
      }),
    );
    context.getRuntimeConfig = roleConfig;
    if (cold) {
      context.disconnectClientsForUserProfile = disconnect;
      expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
    }
    const harness = createDispatchTestHarness({
      connId: client.connId,
      getRequiredSharedGatewaySessionGeneration: new SharedGatewaySessionGenerationState({
        current: "generation-a",
        required: null,
      }).reader,
      buildRequestContext: () => context,
      extraHandlers: usersHandlers,
    });
    boundary.failRole = scenario === "failed delivery";
    await harness.dispatcher.dispatch(
      {
        type: "req",
        id: "role",
        method: "users.setRole",
        params: { profileId: changedId, role: "reader" },
        ...(requester ? { expectedProfileId: requester.id } : {}),
      },
      client,
    );
    if (!cold) {
      expect(readResidentUserProfileIdentity(changedId)?.role).toBe("reader");
      expect(scopes()).toEqual(["operator.read"]);
      expect(self ? clientClose : targetClose).toHaveBeenCalledOnce();
      expect(self ? targetClose : clientClose).not.toHaveBeenCalled();
    } else {
      expect(disconnect).not.toHaveBeenCalled();
    }
    expect(await harness.awaitResponseFrame("role")).toMatchObject({
      id: "role",
      ...(self
        ? { ok: true, payload: { profile: { id: changedId, role: "reader" } } }
        : {
            ok: false,
            error: {
              code: cold ? "INVALID_REQUEST" : "UNAVAILABLE",
              message: expect.stringContaining(
                cold ? "user profile not found" : "synthetic committed role delivery failure",
              ),
            },
          }),
    });
  },
);
