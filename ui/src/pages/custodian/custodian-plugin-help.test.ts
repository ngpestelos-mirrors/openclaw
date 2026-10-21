/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QUICK_ACTIONS_QUESTION } from "../../test-helpers/custodian-quick-actions.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import {
  createPluginHelpRequest,
  currentPluginHelpReference,
  publishPluginHelpContext,
} from "./plugin-help.ts";

const plugin = {
  id: "example",
  name: "Example Plugin",
  declared: { tools: ["example_search"], providers: ["example-provider"] },
};
const greeting = {
  sessionId: "plugin-help-session",
  reply: "Gateway, configuration, and channels are healthy.",
  action: "none",
  optionalWelcome: true,
  question: QUICK_ACTIONS_QUESTION,
};
const selection = { installed: true, overview: true };
const prompt = "What does Example Plugin do?";
const query = <T extends Element = HTMLElement>(page: ParentNode, selector: string) =>
  page.querySelector<T>(selector);
const reply = (text: string) => ({ sessionId: greeting.sessionId, reply: text, action: "none" });
const requestWithAnswer = (text: string) =>
  vi.fn().mockResolvedValueOnce(greeting).mockResolvedValueOnce(reply(text));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/settings/plugins/example");
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mountPluginHelp(request: Parameters<typeof createContext>[0]) {
  const harness = createContext(request);
  publishPluginHelpContext(harness.context, {}, plugin, selection);
  const mounted = await mountPage(harness.context, { onboarding: false });
  await waitForFast(() => expect(mounted.page.store.sending).toBe(false));
  await mounted.page.updateComplete;
  return { ...harness, ...mounted };
}

it("replaces optional welcome actions with plugin starters and keeps them unsent", async () => {
  const request = requestWithAnswer("This plugin adds useful capabilities.");
  const { page } = await mountPluginHelp(request);
  expect(page.textContent).not.toContain(greeting.reply);
  expect(page.querySelector("openclaw-option-card")).toBeNull();
  expect(page.querySelector(".custodian__plugin-intro")?.textContent).toContain(plugin.name);
  const starters = page.querySelectorAll<HTMLButtonElement>(".custodian__plugin-starters button");
  expect(Array.from(starters, (button) => button.textContent?.trim())).toEqual([
    "What does it do?",
    "What tools does it have?",
    "How do I set it up?",
  ]);
  const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
  page.store.setInput("Keep my existing draft.");
  await page.updateComplete;
  starters[0]!.click();
  await page.updateComplete;
  const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(composer.value).toBe("Keep my existing draft.\n\nWhat does Example Plugin do?");
  expect(document.activeElement).toBe(composer);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[1]).not.toHaveProperty("message");
  const focus = vi.spyOn(composer, "focus");
  page.store.setInput(composer.value);
  await page.updateComplete;
  expect(focus).not.toHaveBeenCalled();
  expect(reveal).not.toHaveBeenCalled();

  page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    sessionId: greeting.sessionId,
    message: "Keep my existing draft.\n\nWhat does Example Plugin do?",
    context: { plugin: { ...plugin, installed: true } },
  });
  await waitForFast(() => expect(page.store.sending).toBe(false));
  await page.updateComplete;
  expect(page.querySelector(".custodian__plugin-intro")).toBeNull();
  expect(page.textContent).toContain("This plugin adds useful capabilities.");
  expect(page.textContent).not.toContain(greeting.reply);
  expect(page.querySelector("openclaw-option-card")).toBeNull();
  expect(reveal).toHaveBeenLastCalledWith({ block: "nearest" });
});

it("preserves an existing conversation and draft when a plugin becomes selected", async () => {
  const request = requestWithAnswer("Your existing conversation answer.");
  const { context } = createContext(request);
  const { page } = await mountPage(context, { onboarding: false });
  await waitForFast(() => expect(page.store.canSend).toBe(true));
  await page.store.send("An earlier question.");
  page.store.setInput("An unsent follow-up.");
  const messages = page.store.messages;
  publishPluginHelpContext(context, {}, plugin, selection);
  await page.updateComplete;
  expect(page.store.messages).toBe(messages);
  expect(page.textContent).toContain("Your existing conversation answer.");
  expect(page.querySelector(".custodian__plugin-intro")).toBeNull();
  expect(page.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("An unsent follow-up.");
  expect(request).toHaveBeenCalledTimes(2);
});

it("retires an authored question intent when the operator changes on the same plugin", async () => {
  const request = vi.fn().mockResolvedValue(greeting);
  const { page, context, setGatewayToken } = await mountPluginHelp(request);
  const ask = createPluginHelpRequest(context, plugin);
  setGatewayToken("replacement-fixture-operator");
  publishPluginHelpContext(context, {}, plugin, selection);
  await waitForFast(() => expect(page.store.canSend).toBe(true));
  await ask({ question: prompt });
  await page.updateComplete;
  expect(page.store.input).toBe("");
  expect(request.mock.calls.every(([, params]) => params.message === undefined)).toBe(true);
});

it.each([false, true])(
  "keeps required Gateway content visible (hosted input=%s)",
  async (hosted) => {
    const text = hosted ? "Connect the provider." : "A manual configuration edit needs attention.";
    const request = vi.fn().mockResolvedValue(
      hosted
        ? {
            ...reply(text),
            wizardInputPending: true,
            sensitive: true,
            step: { id: "key", type: "text", message: "Provider API key", sensitive: true },
          }
        : { ...greeting, optionalWelcome: false, reply: text },
    );
    const { page } = await mountPluginHelp(request);
    expect(page.textContent).toContain(text);
    if (hosted) {
      expect(page.querySelector(".custodian__plugin-intro")).toBeNull();
      expect(query(page, ".custodian__wizard-step")?.textContent).toContain("Provider API key");
      expect(page.querySelector('input[type="password"]')).not.toBeNull();
    } else {
      expect(page.querySelector(".custodian__plugin-intro")).not.toBeNull();
    }
    expect(request).toHaveBeenCalledOnce();
  },
);

it("keeps failed inference visible and starter drafts editable without admitting a send", async () => {
  const request = vi.fn().mockRejectedValue(new Error("Inference is unavailable."));
  const { page } = await mountPluginHelp(request);
  expect(page.querySelector('[role="alert"]')?.textContent).toContain("Inference is unavailable.");
  const starter = query<HTMLButtonElement>(page, ".custodian__plugin-starters button")!;
  expect(starter).not.toBeNull();
  starter.click();
  await page.updateComplete;
  expect(query<HTMLTextAreaElement>(page, "textarea")?.value).toBe(prompt);
  expect(query<HTMLButtonElement>(page, ".chat-send-btn")?.disabled).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});

it("keeps the selected setting within the context budget when declarations finish loading", async () => {
  const { context } = createContext(vi.fn());
  const owner = {};
  publishPluginHelpContext(context, owner, plugin, selection);
  const path = ["accounts", "account.with.dots", "enabled"];
  const ask = createPluginHelpRequest(context, plugin);
  await ask({
    path,
    label: "Enabled",
    value: true,
    sensitive: false,
  });
  publishPluginHelpContext(
    context,
    owner,
    {
      ...plugin,
      declared: { tools: Array.from({ length: 12 }, (_, i) => `tool_${i}_${"x".repeat(100)}`) },
    },
    selection,
  );
  const reference = currentPluginHelpReference(context);
  expect(reference).toMatchObject({ setting: { path }, declared: { incomplete: true } });
  expect(JSON.stringify(reference).length).toBeLessThanOrEqual(1024);
});
