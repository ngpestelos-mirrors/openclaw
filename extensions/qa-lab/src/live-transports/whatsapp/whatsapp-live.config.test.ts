import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshot, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/health";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { buildQaGatewayConfig } from "../../qa-gateway-config.js";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import { whatsappConversationScenarios } from "./whatsapp-live.scenario-implementations.conversation.js";

it("preserves audio preflight when enabling message actions", () => {
  const media = {
    audio: { enabled: false },
    models: [{ provider: "openai", model: "existing-transcriber", capabilities: ["audio"] }],
  } satisfies NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>;
  const base: OpenClawConfig = { tools: { alsoAllow: ["browser"], media } };
  const cfg = buildWhatsAppQaConfig(base, {
    allowFrom: ["+15550000001"],
    authDir: "/tmp/whatsapp-qa-auth",
    dmPolicy: "allowlist",
    ownerAllowFrom: ["+15550000001"],
    overrides: { audioPreflight: true, actions: true },
    sutAccountId: "sut",
  });

  expect(cfg.tools).toMatchObject({
    alsoAllow: ["browser", "message"],
    media: {
      audio: { enabled: true },
      models: [
        { provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] },
        { provider: "openai", model: "existing-transcriber", capabilities: ["audio"] },
      ],
    },
  });
  expect(base.tools?.media?.audio?.enabled).toBe(false);
});

it.each(["generated", "explicit"] as const)(
  "builds valid WhatsApp broadcast config from the %s roster without replacing agents",
  (roster) =>
    withTempHome(
      async (home) => {
        const groupJid = "120363000000000000@g.us";
        const base = buildQaGatewayConfig({
          bind: "loopback",
          gatewayPort: 18789,
          gatewayToken: "test-token",
          workspaceDir: path.join(home, "workspace"),
        });
        if (roster !== "generated") {
          base.agents = {
            ...base.agents,
            ownership: "explicit",
            defaults: { ...base.agents?.defaults, systemAgent: { agentId: "main" } },
            entries: {
              ...base.agents?.entries,
              main: { identity: { name: "Existing" }, model: "mock-openai/custom" },
            },
          };
        }
        const original = structuredClone(base);
        const cfg = buildWhatsAppQaConfig(base, {
          allowFrom: ["*"],
          authDir: path.join(home, "auth"),
          dmPolicy: "open",
          groupJid,
          ownerAllowFrom: ["+15550000001"],
          overrides:
            whatsappConversationScenarios.whatsappQaBroadcastGroupFanoutScenario.configOverrides,
          sutAccountId: "sut",
        });

        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.writeFile(configPath, JSON.stringify(cfg));
        const snapshot = await readConfigFileSnapshot({
          pluginValidation: "core-only",
          observe: false,
        });
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        expect(cfg.agents?.defaults).toMatchObject(original.agents?.defaults ?? {});
        const route = { channel: "whatsapp", accountId: "sut" };
        expect(resolveAgentRoute({ cfg, ...route }).agentId).toBe(
          resolveAgentRoute({ cfg: original, ...route }).agentId,
        );
        for (const agentId of Object.keys(original.agents?.entries ?? {})) {
          expect(resolveAgentWorkspaceDir(cfg, agentId)).toBe(
            resolveAgentWorkspaceDir(original, agentId),
          );
        }
        const entries = cfg.agents?.entries ?? {};
        expect(entries).toMatchObject(original.agents?.entries ?? {});
        expect(Object.keys(entries)).toEqual(["qa", "main", "qa-second"]);
        expect(entries["qa-second"]).toEqual({ identity: { name: "Second WhatsApp QA" } });
        expect(cfg.broadcast?.strategy).toBe("sequential");
        expect(cfg.broadcast?.[groupJid]).toEqual(["main", "qa-second"]);
        const group = cfg.channels?.whatsapp?.accounts?.sut?.groups?.[groupJid];
        expect(group?.requireMention).toBe(true);
        expect(base).toEqual(original);
      },
      { env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") } },
    ),
);
