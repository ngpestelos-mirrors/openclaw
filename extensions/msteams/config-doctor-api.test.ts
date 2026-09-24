import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";
import { MSTeamsConfigSchema } from "./src/config-schema.js";
import { collectMSTeamsWebhookWarnings } from "./src/doctor.js";

describe("Microsoft Teams Gateway webhook migration", () => {
  it("migrates an explicit port and streaming aliases into accepted channel config", () => {
    const old = {
      enabled: true,
      webhook: { port: 3978, path: "/teams/events" },
      streamMode: "block",
    };
    expect(MSTeamsConfigSchema.safeParse(old).success).toBe(false);
    expect(legacyConfigRules.some((rule) => rule.match?.(old, {}))).toBe(true);
    const migrated = normalizeCompatibilityConfig({
      cfg: { channels: { msteams: old } } as OpenClawConfig,
    });
    const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
    expect(channel.webhook).toEqual({ path: "/teams/events" });
    expect(channel.legacyWebhook).toEqual({ port: 3978 });
    expect(channel.streaming?.mode).toBe("block");
    expect(collectMSTeamsWebhookWarnings({ cfg: migrated.config, env: {} }).join(" ")).toContain(
      "18789/teams/events",
    );
  });

  it("does not invent a listener for the former default port and names the new upstream", () => {
    const cfg: OpenClawConfig = {
      gateway: { port: 19001 },
      channels: { msteams: { webhook: { path: "/teams/events" } } },
    };
    const migrated = normalizeCompatibilityConfig({ cfg });
    expect(migrated.config.channels?.msteams?.legacyWebhook).toBeUndefined();
    expect(migrated.changes).toEqual([]);
    expect(
      collectMSTeamsWebhookWarnings({ cfg, env: { OPENCLAW_GATEWAY_PORT: "19002" } }).join(" "),
    ).toContain("19002/teams/events");
    expect(
      collectMSTeamsWebhookWarnings({ cfg, env: { OPENCLAW_GATEWAY_PORT: "19002" } }).join(" "),
    ).toContain("3978");
  });

  it.each([
    ["/health", "is reserved for Gateway probes"],
    ["/healthz", "is reserved for Gateway probes"],
    ["/ready", "is reserved for Gateway probes"],
    ["/readyz", "is reserved for Gateway probes"],
    ["/startup", "is reserved for Gateway probes"],
    ["/startupz", "is reserved for Gateway probes"],
    ["/api/channels/teams", "requires Gateway authentication"],
    ["/%61pi/channels/teams", "requires Gateway authentication"],
  ])(
    "diagnoses unavailable %s callbacks with and without explicit legacy forwarding",
    (path, reason) => {
      for (const legacyWebhook of [undefined, { port: 3978 }]) {
        const cfg: OpenClawConfig = {
          channels: { msteams: { webhook: { path: `${path}?tenant=one` }, legacyWebhook } },
        };
        const warning = collectMSTeamsWebhookWarnings({ cfg, env: {} }).join(" ");
        expect(warning).toContain(`${path}?tenant=one ${reason}`);
        expect(warning).toContain("18789/api/messages");
        expect(warning).toContain(
          legacyWebhook ? "legacy port 3978 continues" : "cannot receive Teams callbacks",
        );
      }
    },
  );

  it("does not classify nested probe paths as reserved or warn for disabled channels", () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { webhook: { path: "/health/messages" } } },
    };
    expect(collectMSTeamsWebhookWarnings({ cfg, env: {} }).join(" ")).not.toContain("reserved");
    expect(
      collectMSTeamsWebhookWarnings({ cfg: { channels: { msteams: { enabled: false } } } }),
    ).toEqual([]);
  });
});
