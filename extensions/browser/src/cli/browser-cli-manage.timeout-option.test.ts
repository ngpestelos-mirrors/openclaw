import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserManageProgram,
  findBrowserManageCall,
  getBrowserManageGatewayMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

const fixedBudgetRequests = [
  { args: ["status"], path: "/" },
  { args: ["tabs"], path: "/tabs" },
  { args: ["tab"], path: "/tabs/action" },
  { args: ["tab", "new"], path: "/tabs/action" },
  { args: ["tab", "label", "tab-1", "work"], path: "/tabs/action" },
  { args: ["tab", "select", "1"], path: "/tabs/action" },
  { args: ["tab", "close", "1"], path: "/tabs/action" },
  { args: ["open", "https://example.com"], path: "/tabs/open" },
  { args: ["focus", "tab-1"], path: "/tabs/focus" },
  { args: ["close", "tab-1"], path: "/tabs/tab-1" },
  { args: ["profiles"], path: "/profiles" },
  { args: ["system-profiles"], path: "/system-profiles" },
  { args: ["import-profile"], path: "/profiles/import" },
];

function run(...args: string[]) {
  return createBrowserManageProgram({ withParentTimeout: true }).parseAsync(["browser", ...args], {
    from: "user",
  });
}

function expectBudget(path: string, timeoutMs: number) {
  const request = findBrowserManageCall(path);
  expect(request?.[1].timeout).toBe(String(timeoutMs + 130_000));
  expect(request?.[2].timeoutMs).toBe(timeoutMs);
}

describe("browser manage timeout option", () => {
  beforeEach(() => {
    getBrowserManageGatewayMock().mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    { args: ["reset-profile"], path: "/reset-profile" },
    { args: ["create-profile", "--name", "work"], path: "/profiles/create" },
  ])("inherits parent --timeout for $path", async ({ args, path }) => {
    await run("--timeout", "60000", "--json", ...args);
    expectBudget(path, 60000);
  });

  it("combines browser profile with browser start --headless", async () => {
    await run("--timeout", "60000", "--browser-profile", "work", "start", "--headless");
    expect(findBrowserManageCall("/start")?.[2].query).toEqual({
      profile: "work",
      headless: "true",
    });
    expectBudget("/start", 60000);
    expect(findBrowserManageCall("/")?.[2].timeoutMs).toBe(60000);
  });

  it.each(fixedBudgetRequests)("honors the authored budget for $args", async ({ args, path }) => {
    await run("--timeout", "30000", "--json", ...args);
    expectBudget(path, 30000);
  });

  it("rejects invalid authored timeouts before dispatch", async () => {
    await expect(run("tabs", "--timeout", "0")).rejects.toThrow(
      "--timeout must be a positive integer.",
    );
    expect(getBrowserManageGatewayMock()).not.toHaveBeenCalled();
  });

  it("keeps the deep snapshot bounded independently of the management timeout", async () => {
    getBrowserManageGatewayMock()
      .mockResolvedValueOnce({
        status: { enabled: true, running: true, profile: "work" },
        checks: [],
      })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValueOnce({ tabs: [] })
      .mockResolvedValueOnce({ format: "aria", nodes: [{}] });
    await run("--json", "--timeout", "60000", "doctor", "--deep");
    for (const route of ["/doctor", "/profiles", "/tabs", "/snapshot"]) {
      expectBudget(route, route === "/snapshot" ? 10000 : 60000);
    }
    expect(
      getBrowserManageGatewayMock().mock.calls.filter((call) => call[2].path === "/snapshot"),
    ).toHaveLength(1);
  });

  it("honors the authored budget on both stop and its status readback", async () => {
    await run("--timeout", "60000", "stop");
    for (const route of ["/stop", "/"]) {
      expectBudget(route, 60000);
    }
  });
});
