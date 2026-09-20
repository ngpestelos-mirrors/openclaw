import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { readUserProfileIdentity } from "../../../state/user-profile-list.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import {
  createRequiredSharedGatewaySessionGenerationReader,
  type SharedGatewaySessionGenerationState,
} from "../../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

vi.mock("../../../state/user-profile-list.js", () => ({ readUserProfileIdentity: vi.fn() }));
vi.mock("../../session-sharing.js", async () => ({
  // The probe has no session target; its request and selection owners remain real.
  resolveSessionMutationAuthorization: vi.fn(() => ({ error: null })),
  SessionMutationAuthorizationChangedError: (
    await import("../../session-mutation-authorization-error.js")
  ).SessionMutationAuthorizationChangedError,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetGatewayWorkAdmission();
});

describe("authenticated request mutation custody", () => {
  it.each([
    "unchanged",
    "transport retirement",
    "client invalidated",
    "generation rotated",
    "selection mismatch",
    "opaque generation reader",
    "copied generation reader",
    "reminted generation reader",
  ] as const)("retains the admitted authority for %s", async (scenario) => {
    const generation: SharedGatewaySessionGenerationState = {
      current: "generation-a",
      required: null,
    };
    const connection = new AbortController();
    const client = createOperatorWsClient();
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = "generation-a";
    client.connectionSignal = connection.signal;
    client.authenticatedUserProfile = {
      profileId: "profile-owner",
      displayName: null,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: 1,
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const persisted = vi.fn();
    const grantProfileReads = vi.fn();
    const compatibilityReader =
      scenario === "opaque generation reader" ||
      scenario === "copied generation reader" ||
      scenario === "reminted generation reader";
    const generationReader = createRequiredSharedGatewaySessionGenerationReader(generation);
    const unboundReader = () => generation.current;
    if (scenario === "reminted generation reader") {
      for (const key of Object.getOwnPropertySymbols(generationReader)) {
        const value = Object.getOwnPropertyDescriptor(generationReader, key)?.value;
        const Issuer = value.constructor;
        if (typeof Issuer === "function") {
          Object.defineProperty(unboundReader, key, {
            value: new Issuer(unboundReader, generation),
          });
        }
      }
    }
    let inGrant = false;
    let grantError: unknown;
    vi.mocked(readUserProfileIdentity).mockImplementation((profile) => {
      if (inGrant) {
        grantProfileReads();
        throw new Error("host profile storage entered during worker admission");
      }
      return { profileId: profile, role: null, aliases: new Set([profile]) };
    });
    const harness = createDispatchTestHarness({
      getRequiredSharedGatewaySessionGeneration:
        scenario === "copied generation reader"
          ? Object.defineProperties(
              () => generation.current,
              Object.getOwnPropertyDescriptors(generationReader),
            )
          : compatibilityReader
            ? unboundReader
            : generationReader,
      buildRequestContext: () => createDirectChatContext(),
      extraHandlers: {
        "test.mutation-custody": async (options) => {
          const authority = readGatewayRequestMutationAuthority(options);
          expect(authority.family).toBe(compatibilityReader ? "native-compatibility" : "worker");
          entered.resolve();
          await release.promise;
          try {
            if (compatibilityReader) {
              authority.assertCurrent();
            } else {
              if (authority.family !== "worker") {
                throw new Error("WS request lost its worker custody before handler invocation");
              }
              const forged = { ...options };
              const reminted = { ...options };
              const forgedReader = vi.fn(() => authority);
              for (const key of Object.getOwnPropertySymbols(options)) {
                const value = Object.getOwnPropertyDescriptor(options, key)?.value;
                const Issuer = value.constructor;
                if (typeof Issuer === "function") {
                  Object.defineProperty(reminted, key, {
                    value: new Issuer(reminted, authority),
                    configurable: true,
                  });
                }
                Object.defineProperty(forged, key, {
                  value: Object.assign(Object.create(Object.getPrototypeOf(value)), {
                    read: forgedReader,
                  }),
                  configurable: true,
                });
              }
              // Neither ordinary copies nor copied private descriptors transfer invocation custody.
              for (const copy of [
                { ...options },
                Object.assign(Object.create(options), options),
                Object.defineProperties({}, Object.getOwnPropertyDescriptors(options)),
                forged,
                reminted,
              ]) {
                expect(readGatewayRequestMutationAuthority(copy).family).toBe(
                  "native-compatibility",
                );
              }
              expect(forgedReader).not.toHaveBeenCalled();
              inGrant = true;
              authority.assertWorkerCurrent();
              expect(authority.expectedProfileBinding).toBeDefined();
              authority.expectedProfileBinding?.assertMatchesResolvedProfile(
                scenario === "selection mismatch" ? "different-profile" : "profile-owner",
              );
            }
            persisted();
          } catch (error) {
            grantError = error;
          } finally {
            inGrant = false;
          }
          options.respond(true, { settled: true });
        },
      },
    });
    const dispatch = harness.dispatcher.dispatch(
      {
        type: "req",
        id: "mutation-custody",
        method: "test.mutation-custody",
        expectedProfileId: "profile-owner",
        params: {},
      },
      client,
    );
    try {
      await Promise.race([
        entered.promise,
        dispatch.then(() => {
          throw new Error("request returned before reaching its mutation owner");
        }),
      ]);
      if (scenario === "transport retirement") {
        connection.abort();
      } else if (scenario === "client invalidated") {
        client.invalidated = true;
      } else if (scenario === "generation rotated" || compatibilityReader) {
        generation.current = "generation-b";
      }
    } finally {
      release.resolve();
      await dispatch;
    }
    expect(grantProfileReads).not.toHaveBeenCalled();
    if (scenario === "unchanged" || scenario === "transport retirement") {
      expect(grantError).toBeUndefined();
      expect(persisted).toHaveBeenCalledOnce();
    } else {
      expect(grantError).toBeInstanceOf(Error);
      expect(persisted).not.toHaveBeenCalled();
    }
    if (scenario === "selection mismatch") {
      expect(grantError).toMatchObject({
        error: {
          details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
        },
      });
    }
  });
});
