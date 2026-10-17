import { afterEach, beforeEach, expect, vi } from "vitest";
import type {
  UsersAuthConnectStartResult as Flow,
  UsersAuthConnectStatusResult as Status,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AuthProfileCredential, OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
} from "../../plugins/types.js";
import type { UserProfileAuthLink } from "../../state/user-model-accounts.js";
import { createModelAccountConnectService } from "../model-account-connect.js";
import { broadcastChatMetadataChanged } from "../server-chat-metadata-lifecycle.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { usersAuthConnectHandlers } from "./users-auth-connect.js";

const resolveProfileId = vi.hoisted(() => vi.fn());
const prepareUserProfileSelectionAuthority = vi.hoisted(() => vi.fn());
const connectUserModelAccount = vi.hoisted(() => vi.fn());
const listUserProfileAuthLinks = vi.hoisted(() => vi.fn());
const listUserModelAccounts = vi.hoisted(() => vi.fn());
const readUserModelAccountSummary = vi.hoisted(() => vi.fn());
const readSelectedUserModelAccount = vi.hoisted(() => vi.fn());
const setUserProfileAuthLink = vi.hoisted(() => vi.fn());
const clearUserProfileAuthLink = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreWithoutExternalProfiles = vi.hoisted(() => vi.fn());
const registerSecretValueForRedaction = vi.hoisted(() => vi.fn());
const listPersonalAccountAuthChoices = vi.hoisted(() => vi.fn());
const resolvePersonalAccountAuthMethod = vi.hoisted(() => vi.fn());
const exchange = vi.hoisted(() => vi.fn());
const modelAccountLinksCurrent = vi.hoisted(() => vi.fn());
export {
  resolveProfileId,
  prepareUserProfileSelectionAuthority,
  connectUserModelAccount,
  listUserProfileAuthLinks,
  listUserModelAccounts,
  readUserModelAccountSummary,
  readSelectedUserModelAccount,
  setUserProfileAuthLink,
  clearUserProfileAuthLink,
  ensureAuthProfileStoreWithoutExternalProfiles,
  registerSecretValueForRedaction,
  resolvePersonalAccountAuthMethod,
  exchange,
  modelAccountLinksCurrent,
};

function selectionAuthority(reference: string) {
  const profileId = resolveProfileId(reference);
  return {
    profileId,
    isCurrent: () =>
      resolveProfileId(reference) === profileId && resolveProfileId(profileId) === profileId,
  };
}

vi.mock(import("../../state/user-channel-identity-operations.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  prepareUserProfileSelectionAuthority,
  prepareUserProfileRolePolicyAuthority: async (reference: string) => ({
    ...selectionAuthority(reference),
    role: null,
    githubLogin: null,
  }),
}));
vi.mock(import("../../state/user-profile-events.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  captureUserProfileModelAccountLinksAuthority: () => modelAccountLinksCurrent,
}));
vi.mock("../../state/openclaw-state-worker-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-worker-context.js")>()),
  captureOpenClawStateWorkerContext: () => ({}),
}));
vi.mock(import("../../state/user-model-account-operations.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  connectUserModelAccountAsync: connectUserModelAccount,
  listUserProfileAuthLinksAsync: listUserProfileAuthLinks,
  listUserModelAccountsAsync: listUserModelAccounts,
  readUserModelAccountSummaryAsync: readUserModelAccountSummary,
  readSelectedUserModelAccountAsync: readSelectedUserModelAccount,
  setUserProfileAuthLinkAsync: setUserProfileAuthLink,
  clearUserProfileAuthLinkAsync: clearUserProfileAuthLink,
}));
vi.mock(import("../../agents/auth-profiles/store-runtime.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  ensureAuthProfileStoreWithoutExternalProfiles,
  ensureAuthProfileStoreWithoutExternalProfilesAsync: async (...args: unknown[]) =>
    ensureAuthProfileStoreWithoutExternalProfiles(...args),
}));
vi.mock(import("../../logging/secret-redaction-registry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  registerSecretValueForRedaction,
}));
vi.mock(import("../../plugins/personal-account-auth.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  listPersonalAccountAuthChoices,
  resolvePersonalAccountAuthMethod,
}));

type Client = GatewayClient & { connId: string; invalidated: boolean };
type LinkChange = { profileId: string; provider: string; assertCurrent?: () => void };
type ConnectWrite = {
  ownerProfileId: string;
  credential: AuthProfileCredential;
  assertCurrent: () => void;
};
export const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  accountId: "workspace-1",
  expires: 123,
  clientId: "synthetic-client",
  authorizationScope: "openid profile resource.invoke offline_access",
};
export const authorized: ProviderAuthResult = {
  profiles: [{ profileId: "openai:ignored-shared-id", credential }],
};
export const savedId = "personal:profile-1:saved";
export const selectedAccount = { provider: "openai", authProfileId: savedId };
export const metadataEvent = ["chat.metadata.changed", {}, { dropIfSlow: true }] as const;
export function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}
export const runAuth = vi.fn(async (ctx: ProviderAuthContext) => {
  const value = await ctx.prompter.text({
    message: "Provider credential",
    sensitive: true,
    validate: (answer) => (answer === "synthetic-code" ? undefined : `Invalid: ${answer}`),
  });
  return exchange(value, ctx.signal);
});
export const broadcast = vi.fn();
export const warn = vi.fn();
export let service: ReturnType<typeof createModelAccountConnectService>;
let context: ReturnType<typeof createContext>;
export let config: OpenClawConfig;
export let clients: Set<Client>;
export let self: Client;
export let writes: AuthProfileCredential[];
export let linksByOwner: Map<string, UserProfileAuthLink[]>;

function createContext() {
  return {
    broadcast,
    logGateway: { ...createSubsystemLogger("gateway"), warn },
    modelAccountConnectService: service,
    getRuntimeConfig: () => config,
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients].filter((c) => !c.invalidated && (!filter || filter(c))).map((c) => c.connId),
      ),
  };
}

export function createClient(profileId = "profile-1", scopes = ["operator.write"]): Client {
  const clientInfo = { id: "test", mode: "test", version: "1", platform: "test" };
  const client: Client = {
    connId: `connection-${clients.size + 1}`,
    invalidated: false,
    authenticatedUserProfile: { profileId, displayName: "Ada", hasAvatar: false, updatedAt: 1 },
    connect: { role: "operator", scopes, minProtocol: 1, maxProtocol: 1, client: clientInfo },
  };
  clients.add(client);
  return client;
}

export async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  client: Client = self,
) {
  const respond = vi.fn();
  await usersAuthConnectHandlers[method]!({
    req: { type: "req", id: "connect-test", method, params },
    client,
    context: context as GatewayRequestContext,
    params,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}

export async function expectReply(response: ReturnType<typeof rpc>, payload: unknown) {
  expect(await response).toHaveBeenCalledWith(true, payload);
}

export async function expectError(response: ReturnType<typeof rpc>, code: string, details = {}) {
  const error = expect.objectContaining({ code, ...details });
  expect(await response).toHaveBeenCalledExactlyOnceWith(false, undefined, error);
}
export function flowRpc(
  action: "answer" | "cancel" | "status",
  flow: Flow,
  params: Record<string, unknown> = {},
  profileId = "profile-1",
  client = self,
) {
  const input = { profileId, connectId: flow.connectId, ...params };
  return rpc(`users.authConnect.${action}`, input, client);
}
export async function startFlow(
  profileId = "profile-1",
  client = self,
  provider = "openai",
  method = "oauth",
): Promise<Flow> {
  const respond = await rpc("users.authConnect.start", { profileId, provider, method }, client);
  const flow = respond.mock.calls[0]?.[1] as Flow;
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  expect(flow.connectId).toEqual(expect.any(String));
  const pending = { status: "pending", step: { type: "text" } };
  await vi.waitFor(async () =>
    expect(await status(flow, profileId, client)).toMatchObject(pending),
  );
  return flow;
}
export async function complete(flow: Flow, profileId = "profile-1", client = self) {
  const current: Status = await status(flow, profileId, client);
  const stepId = current.status === "pending" ? current.step!.id : "retired-step";
  return flowRpc("answer", flow, { stepId, value: "synthetic-code" }, profileId, client);
}
export async function terminal(flow: Flow, state: string, owner = "profile-1", client = self) {
  await vi.waitFor(async () =>
    expect(await status(flow, owner, client)).toMatchObject({ status: state }),
  );
  return status(flow, owner, client);
}
export async function status(flow: Flow, profileId = "profile-1", client = self) {
  const respond = await flowRpc("status", flow, {}, profileId, client);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1];
}

function replaceLinks(owner: string, links: UserProfileAuthLink[]) {
  linksByOwner.set(owner, links);
  return links;
}

export function setupModelAccountConnectTest() {
  beforeEach(() => {
    vi.resetAllMocks();
    modelAccountLinksCurrent.mockReturnValue(true);
    config = {};
    clients = new Set();
    self = createClient();
    writes = [];
    linksByOwner = new Map();
    listUserProfileAuthLinks.mockImplementation((owner: string) => linksByOwner.get(owner) ?? []);
    listUserModelAccounts.mockReturnValue({ accounts: [] });
    const profiles = { "openai:shared": credential };
    ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({ version: 1, profiles });
    clearUserProfileAuthLink.mockImplementation((params: LinkChange) => {
      const { profileId, provider, assertCurrent } = params;
      assertCurrent?.();
      return replaceLinks(
        profileId,
        (linksByOwner.get(profileId) ?? []).filter((link) => link.provider !== provider),
      );
    });
    setUserProfileAuthLink.mockImplementation((params: LinkChange & { authProfileId: string }) => {
      params.assertCurrent?.();
      return replaceLinks(params.profileId, [
        { provider: params.provider, authProfileId: params.authProfileId, updatedAt: 2 },
      ]);
    });
    resolveProfileId.mockImplementation((id: string) => id);
    prepareUserProfileSelectionAuthority.mockImplementation(async (reference: string) =>
      selectionAuthority(reference),
    );
    listPersonalAccountAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "oauth",
        choiceLabel: "Browser sign-in",
        groupLabel: "OpenAI",
      },
    ]);
    const method: ProviderAuthMethod = {
      id: "oauth",
      label: "Browser sign-in",
      kind: "oauth",
      run: runAuth,
    };
    resolvePersonalAccountAuthMethod.mockReturnValue(method);
    exchange.mockResolvedValue(authorized);
    connectUserModelAccount.mockImplementation((params: ConnectWrite) => {
      const { ownerProfileId: owner, credential: next, assertCurrent } = params;
      assertCurrent();
      writes.push(next);
      const authProfileId = `personal:${owner}:account-1`;
      const links = replaceLinks(owner, [
        ...(linksByOwner.get(owner) ?? []).filter((link) => link.provider !== next.provider),
        { provider: next.provider, authProfileId, updatedAt: 1 },
      ]);
      return { authProfileId, links };
    });
    service = createModelAccountConnectService({
      getConfig: () => config,
      onChanged: () => broadcastChatMetadataChanged(context),
    });
    context = createContext();
  });
  afterEach(async () => {
    await service.stop();
    vi.restoreAllMocks();
  });
}

export function setConfig(next: OpenClawConfig) {
  config = next;
}

export function restartService() {
  service = createModelAccountConnectService({ getConfig: () => config });
  context.modelAccountConnectService = service;
}
