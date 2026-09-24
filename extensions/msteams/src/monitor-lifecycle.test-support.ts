// Shared SDK mocks and one HTTP listener for the Teams monitor lifecycle suite.
import { once } from "node:events";
import { createServer } from "node:http";
import type { App } from "@microsoft/teams.apps";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import type { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { afterAll, beforeAll, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { createMSTeamsActivityHandler as CreateMSTeamsActivityHandler } from "./monitor-handler.js";
import "./monitor-ingress-mock.test-support.js";
import type { loadMSTeamsSdkWithAuth as LoadMSTeamsSdkWithAuth } from "./sdk.js";

type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
};

type ResolveMSTeamsTeamsConfigMock = (params: {
  cfg: unknown;
  teamIdMode: "bot-framework" | "graph";
  teams: Record<string, unknown>;
}) => Promise<{
  teams: Record<string, unknown>;
  mapping: string[];
  unresolved: string[];
}>;

type ResolveMSTeamsUserAllowlistMock = (params: {
  cfg: unknown;
  entries: string[];
}) => Promise<MSTeamsUserResolution[]>;

type Route = Parameters<typeof registerPluginHttpRoute>[0];
const routes = vi.hoisted(() => new Map<string, Route>());
const monitorReady = vi.hoisted(() => ({ current: Promise.withResolvers<void>() }));
const registerRouteMock = vi.hoisted(() =>
  vi.fn((route: Route) => {
    routes.set(route.path!, route);
    return () => {
      routes.delete(route.path!);
    };
  }),
);
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  registerPluginHttpRoute: registerRouteMock,
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    waitUntilAbort: (signal?: AbortSignal) => {
      monitorReady.current.resolve();
      return actual.waitUntilAbort(signal);
    },
  };
});

const createMSTeamsActivityHandler = vi.hoisted(() =>
  vi.fn<typeof CreateMSTeamsActivityHandler>(() => vi.fn(async () => undefined)),
);
const isSigninInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const isCardActionInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const runMSTeamsFileConsentInvokeHandler = vi.hoisted(() => vi.fn(async () => {}));
const processSdkActivity = vi.hoisted(() => vi.fn<App["process"]>(async () => ({ status: 200 })));
const nativeSdkState = vi.hoisted((): { app?: App } => ({}));
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, options?: Parameters<typeof LoadMSTeamsSdkWithAuth>[1]) => {
    const app = {
      on: vi.fn(),
      event: vi.fn(),
      process: processSdkActivity,
      initialize: vi.fn(async () => {
        const adapter = options!.httpServerAdapter!;
        adapter.registerRoute("POST", String(options?.messagingEndpoint), async ({ body }) => ({
          status: 200,
          body: { body },
        }));
      }),
      tokenProvider: {
        getAppToken: vi.fn(async (scope: string) => ({
          toString: (): string =>
            scope === "https://graph.microsoft.com/.default" ? "graph-token" : "bot-token",
        })),
      },
    };
    if (nativeSdkState.app) {
      app.on.mockImplementation(nativeSdkState.app.on.bind(nativeSdkState.app));
      app.event.mockImplementation(nativeSdkState.app.event.bind(nativeSdkState.app));
      processSdkActivity.mockImplementation(nativeSdkState.app.process.bind(nativeSdkState.app));
    }
    return { app };
  }),
);

const ssoTokenStore = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  save: vi.fn(async () => {}),
  remove: vi.fn(async () => false),
}));

vi.mock("./monitor-handler.js", () => ({
  isCardActionInvokeAuthorized,
  isSigninInvokeAuthorized,
  createMSTeamsActivityHandler,
}));

vi.mock("./file-consent-invoke.js", () => ({
  runMSTeamsFileConsentInvokeHandler,
}));

const resolveAllowlistMocks = vi.hoisted(() => ({
  resolveMSTeamsTeamsConfig: vi.fn<ResolveMSTeamsTeamsConfigMock>(async ({ teams }) => ({
    teams,
    mapping: [],
    unresolved: [],
  })),
  resolveMSTeamsUserAllowlist: vi.fn<ResolveMSTeamsUserAllowlistMock>(async () => []),
}));

vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsTeamsConfig: resolveAllowlistMocks.resolveMSTeamsTeamsConfig,
  resolveMSTeamsUserAllowlist: resolveAllowlistMocks.resolveMSTeamsUserAllowlist,
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: (creds?: unknown, options?: Record<string, unknown>) =>
    loadMSTeamsSdkWithAuth(creds, options),
  createMSTeamsTokenProvider: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  }),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }),
    },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
      },
    },
  }),
}));

vi.mock("./sso-token-store.js", () => ({
  createMSTeamsSsoTokenStoreFs: () => ssoTokenStore,
}));

export async function waitForMSTeamsTestState(
  assertion: () => void | Promise<void>,
): Promise<void> {
  await monitorReady.current.promise;
  await assertion();
}

const routeServer = createServer((req, res) => {
  Object.defineProperty(req.socket, "remoteAddress", {
    configurable: true,
    value: req.headers["x-test-client-ip"] ?? "127.0.0.1",
  });
  const route = routes.get(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error: unknown) => {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});
let routeBaseUrl: string;
let portClaim: Awaited<ReturnType<typeof acquireTestPortBlock>>;
beforeAll(async () => {
  portClaim = await acquireTestPortBlock({ offsets: [0] });
  routeServer.listen(portClaim.port, "127.0.0.1");
  await once(routeServer, "listening");
  const address = routeServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected route server address");
  }
  routeBaseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  routeServer.close();
  await once(routeServer, "close");
  await portClaim.release();
});

export function requireRegisteredMSTeamsConfig(): OpenClawConfig {
  const registered = createMSTeamsActivityHandler.mock.calls[0]?.[0] as
    | { cfg?: OpenClawConfig }
    | undefined;
  if (!registered?.cfg) {
    throw new Error("expected registered MSTeams handler config");
  }
  return registered.cfg;
}

export function requireRegisteredMSTeamsMediaMaxBytes(): number {
  const registered = createMSTeamsActivityHandler.mock.calls[0]?.[0];
  if (!registered) {
    throw new Error("expected registered MSTeams handler dependencies");
  }
  return registered.mediaMaxBytes;
}

export function getMSTeamsMonitorTestState() {
  return {
    routes,
    monitorReady,
    registerRouteMock,
    createMSTeamsActivityHandler,
    isSigninInvokeAuthorized,
    isCardActionInvokeAuthorized,
    runMSTeamsFileConsentInvokeHandler,
    processSdkActivity,
    nativeSdkState,
    loadMSTeamsSdkWithAuth,
    ssoTokenStore,
    resolveAllowlistMocks,
  };
}

export function getMSTeamsRouteBaseUrl(): string {
  return routeBaseUrl;
}
