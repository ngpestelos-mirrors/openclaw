import { afterAll, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { validateUiCommandParams } from "../../../packages/gateway-protocol/src/index.js";
import { createGatewayToolCallerWrapper } from "../../../src/agents/tools/gateway-caller-context.js";
import * as gatewayTransport from "../../../src/agents/tools/in-process-gateway.js";
import { createScreenTool } from "../../../src/agents/tools/screen-tool.js";
import type {
  GatewayClient,
  GatewayRequestContext,
} from "../../../src/gateway/server-methods/types.js";
import { uiCommandHandlers } from "../../../src/gateway/server-methods/ui-command.js";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const suite = createChatFlowE2eSuite();
const callGateway = vi.spyOn(gatewayTransport, "callInProcessGatewayTool");

// The nested suite owns browser teardown before this transport is restored.
afterAll(() => callGateway.mockRestore());

suite.define(() => {
  it("opens the selected session and its app views only in the browser that asked the agent", async () => {
    const source = "agent:main:session-a";
    const destination = "agent:main:session-b";
    const browsers = await Promise.all(
      ["requester", "other-user"].map(async (connId) => {
        const context = await suite.newBrowserContext({ viewport: { width: 1100, height: 800 } });
        const page = await context.newPage();
        const gateway = await installMockGateway(page, {
          sessionKey: source,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "desktop.observe",
            "environments.status",
            "portal.list",
            "ui.command.result",
          ],
          methodResponses: {
            "sessions.list": chatSessionListResponse(),
            "environments.status": {
              id: "preview-desktop",
              type: "worker",
              status: "available",
              desktop: true,
            },
            "desktop.observe": {
              transport: "rfb",
              wsPath: "/desktop/observe?token=synthetic",
              expiresAtMs: 60_000,
              control: false,
            },
            "portal.list": {
              portals: [
                {
                  id: "preview-web",
                  title: "Crabbox web app",
                  port: 3000,
                  listenPort: 43210,
                  tokenQuery: "openclaw_portal=synthetic",
                  publicUrl: "http://127.0.0.1:43210/",
                  url: "http://127.0.0.1:43210/?openclaw_portal=synthetic",
                  createdAtMs: 1,
                },
              ],
            },
          },
        });
        await page.route("http://127.0.0.1:43210/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<h1>Crabbox web app</h1>",
          }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, source));
        await gateway.waitForRequest("chat.startup");
        const client = {
          connId,
          connect: {
            client: {
              id: GATEWAY_CLIENT_IDS.CONTROL_UI,
              version: "test",
              platform: "web",
              mode: "ui",
            },
            caps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
          },
        } as GatewayClient;
        return { page, gateway, client, connId };
      }),
    );
    const deliveries: Promise<void>[] = [];
    const context = {
      getRuntimeConfig: () => ({}),
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(
          browsers.filter(({ client }) => filter?.(client) !== false).map(({ connId }) => connId),
        ),
      broadcastToConnIds: (event, payload, connIds) => {
        for (const browser of browsers) {
          if (connIds.has(browser.connId)) {
            deliveries.push(
              (async () => {
                await browser.gateway.emitGatewayEvent(event, payload);
                if (
                  event === "ui.command" &&
                  validateUiCommandParams(payload) &&
                  payload.requestId
                ) {
                  const report = await browser.gateway.waitForRequest("ui.command.result", {
                    match: { requestId: payload.requestId },
                  });
                  const respond = vi.fn();
                  await expectDefined(
                    uiCommandHandlers["ui.command.result"],
                    "ui.command.result",
                  )({ params: report.params, client: browser.client, respond, context } as never);
                  expect(respond).toHaveBeenCalledWith(true, { ok: true });
                }
              })(),
            );
          }
        }
      },
    } satisfies Partial<GatewayRequestContext>;
    callGateway.mockImplementation(
      async <T>(_method: string, params: Record<string, unknown>): Promise<T> => {
        const respond = vi.fn();
        await expectDefined(
          uiCommandHandlers["ui.command"],
          "ui.command",
        )({ params, respond, context } as never);
        return expectDefined(respond.mock.calls[0], "Gateway response")[1] as T;
      },
    );
    const screen = createGatewayToolCallerWrapper("main", {
      agentSessionKey: source,
      gatewayUiCommandTarget: { connId: "requester" },
    })(
      createScreenTool({
        agentSessionKey: source,
      }),
    );

    await screen.execute("select", { action: "navigate", sessionKey: destination });
    await Promise.all(deliveries);
    await expect
      .poll(() => new URL(expectDefined(browsers[0], "requester").page.url()).pathname)
      .toBe(controlUiSessionPath(destination));
    expect(new URL(expectDefined(browsers[1], "other user").page.url()).pathname).toBe(
      controlUiSessionPath(source),
    );
    expect(deliveries).toHaveLength(1);

    const requester = expectDefined(browsers[0], "requester");
    const other = expectDefined(browsers[1], "other user");
    await installScriptedRfbServer(requester.page);
    await screen.execute("show-native", {
      action: "desktop_show",
      environmentId: "preview-desktop",
      sessionKey: destination,
    });
    await Promise.all(deliveries);
    const desktop = requester.page.locator("openclaw-desktop-panel[embedded]");
    await requester.gateway.waitForRequest("desktop.observe", {
      match: { source: { kind: "environment", environmentId: "preview-desktop" } },
    });
    await desktop.locator("canvas").waitFor();
    expect(await other.gateway.getRequests("desktop.observe")).toHaveLength(0);

    const portal = requester.page.locator("openclaw-portals-page[embedded]");
    await screen.execute("show-web", {
      action: "portal_show",
      portalId: "preview-web",
      sessionKey: destination,
    });
    await Promise.all(deliveries);
    await portal.locator("iframe").waitFor();
    expect(await other.gateway.getRequests("portal.list")).toHaveLength(0);
    await screen.execute("hide-web", { action: "portal_hide", sessionKey: destination });
    await Promise.all(deliveries);
    await portal.waitFor({ state: "detached" });
    expect(await requester.gateway.getRequests("portal.close")).toHaveLength(0);
  });
});
