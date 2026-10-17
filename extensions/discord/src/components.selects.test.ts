// Discord tests cover select component construction and delivery parity.
import { ComponentType, InteractionResponseType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { buildDiscordComponentMessage, createDiscordFormModal } from "./components.js";
import type { DiscordComponentBlock, DiscordModalFieldSpec } from "./components.types.js";
import {
  ChannelSelectMenu,
  Container,
  MentionableSelectMenu,
  RoleSelectMenu,
  Row,
  StringSelectMenu,
  UserSelectMenu,
} from "./internal/components.message.js";
import { BaseComponentInteraction, createInteraction } from "./internal/interactions.js";
import {
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "./internal/test-builders.test-support.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

const GENERATED_DISCORD_ID_PATTERN =
  /(?<![A-Za-z0-9_-])(?:btn|fld|grp|mdl|sel)_[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])/gu;

function normalizeGeneratedDiscordIdBytes(value: string): string {
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();
  return value.replace(GENERATED_DISCORD_ID_PATTERN, (id) => {
    const existing = ids.get(id);
    if (existing) {
      return existing;
    }
    const prefix = id.slice(0, 3);
    const normalized = `${prefix}_${(counters.get(prefix) ?? 0) + 1}`;
    counters.set(prefix, (counters.get(prefix) ?? 0) + 1);
    ids.set(id, normalized);
    return normalized;
  });
}

function normalizeGeneratedDiscordIds(value: unknown): unknown {
  return JSON.parse(normalizeGeneratedDiscordIdBytes(JSON.stringify(value))) as unknown;
}

function readFirstActionRow(result: ReturnType<typeof buildDiscordComponentMessage>) {
  const container = result.components[0];
  if (!(container instanceof Container)) {
    throw new Error("Expected a Discord component container");
  }
  const row = container.components[0];
  if (!(row instanceof Row)) {
    throw new Error("Expected a Discord action row");
  }
  return row;
}

function modalField(
  type: DiscordModalFieldSpec["type"],
  label: string,
  overrides: Partial<DiscordModalFieldSpec> = {},
): DiscordModalFieldSpec {
  return {
    type,
    label,
    minValues: 1,
    maxValues: 1,
    placeholder: `Pick ${label.toLowerCase()}`,
    ...overrides,
  };
}

function serializedField(
  type: ComponentType,
  label: string,
  id: number,
  overrides: Record<string, unknown> = {},
) {
  const { options, ...rest } = overrides;
  return {
    type: ComponentType.Label,
    label,
    component: {
      type,
      ...(options ? { options } : {}),
      custom_id: `fld_${id}`,
      placeholder: `Pick ${label.toLowerCase()}`,
      min_values: 1,
      max_values: 1,
      ...rest,
    },
  };
}

function buttonBlock(length: number): DiscordComponentBlock[] {
  return [
    {
      type: "actions",
      buttons: Array.from({ length }, (_, index) => ({ label: `Button ${index + 1}` })),
    },
  ];
}

describe("discord select components", () => {
  it.each([
    ["string", ComponentType.StringSelect, StringSelectMenu, "select"],
    ["user", ComponentType.UserSelect, UserSelectMenu, "user select"],
    ["role", ComponentType.RoleSelect, RoleSelectMenu, "role select"],
    ["mentionable", ComponentType.MentionableSelect, MentionableSelectMenu, "mentionable select"],
    ["channel", ComponentType.ChannelSelect, ChannelSelectMenu, "channel select"],
  ] as const)(
    "preserves %s identity, payload, and metadata",
    (type, componentType, constructor, defaultLabel) => {
      const options = [
        {
          label: "Primary",
          value: "primary",
          description: "First choice",
          emoji: { name: "1️⃣" },
          default: true,
        },
      ];
      const result = buildDiscordComponentMessage({
        spec: {
          reusable: false,
          blocks: [
            {
              type: "actions",
              select: {
                type,
                callbackData: "select:callback",
                callbackDataKind: "callback",
                minValues: 0,
                maxValues: 2,
                options,
                allowedUsers: ["user-1"],
              },
            },
          ],
        },
        sessionKey: "session-1",
        agentId: "agent-1",
        accountId: "default",
      });
      const select = readFirstActionRow(result).components[0];
      if (!select) {
        throw new Error("Expected a Discord select component");
      }

      expect(select).toBeInstanceOf(constructor);
      expect(normalizeGeneratedDiscordIds(select.serialize())).toEqual({
        type: componentType,
        ...(type === "string" ? { options } : {}),
        custom_id: "occomp:cid=sel_1",
        min_values: 0,
        max_values: 2,
      });
      expect(normalizeGeneratedDiscordIds(result.entries)).toEqual([
        {
          id: "sel_1",
          kind: "select",
          label: defaultLabel,
          callbackData: "select:callback",
          callbackDataKind: "callback",
          selectType: type,
          ...(type === "string" ? { options: [{ value: "primary", label: "Primary" }] } : {}),
          allowedUsers: ["user-1"],
          sessionKey: "session-1",
          agentId: "agent-1",
          accountId: "default",
          reusable: false,
          consumptionGroupId: "grp_1",
          consumptionGroupEntryIds: ["sel_1"],
        },
      ]);
    },
  );

  it("preserves modal identity, required values, and callback payload", async () => {
    const result = buildDiscordComponentMessage({
      spec: {
        modal: {
          title: "Select details",
          fields: [
            modalField("select", "Priority", {
              options: [{ label: "High", value: "high", default: true }],
            }),
            modalField("role-select", "Roles", { required: false, minValues: 0, maxValues: 2 }),
            modalField("user-select", "Owner", { required: true }),
          ],
        },
      },
    });
    const modalEntry = result.modals[0];
    if (!modalEntry) {
      throw new Error("Expected a Discord modal entry");
    }
    const modal = createDiscordFormModal(modalEntry);
    const fields = modal.components.map((label) => {
      if (!("component" in label) || !label.component) {
        throw new Error("Expected a Discord modal label component");
      }
      return label.component;
    });

    expect(fields[0]).toBeInstanceOf(StringSelectMenu);
    expect(fields[1]).toBeInstanceOf(RoleSelectMenu);
    expect(fields[2]).toBeInstanceOf(UserSelectMenu);

    const expectedSerialized = {
      title: "Select details",
      custom_id: "ocmodal:mid=mdl_1",
      components: [
        serializedField(ComponentType.StringSelect, "Priority", 1, {
          options: [{ label: "High", value: "high", default: true }],
        }),
        serializedField(ComponentType.RoleSelect, "Roles", 2, {
          min_values: 0,
          max_values: 2,
          required: false,
        }),
        serializedField(ComponentType.UserSelect, "Owner", 3, { required: true }),
      ],
    };
    expect(normalizeGeneratedDiscordIds(modal.serialize())).toEqual(expectedSerialized);

    const loopback = await createDiscordLoopbackRest();
    try {
      const client = createInternalTestClient();
      client.rest = loopback.rest;
      const interaction = createInteraction(
        client,
        createInternalComponentInteractionPayload({
          id: "interaction-1",
          token: "interaction-token",
        }),
      );
      if (!(interaction instanceof BaseComponentInteraction)) {
        throw new Error("Expected a Discord button interaction");
      }
      await interaction.showModal(modal);

      expect(loopback.requests).toHaveLength(1);
      expect(loopback.requests[0]?.method).toBe("POST");
      expect(loopback.requests[0]?.path).toBe(
        "/v10/interactions/interaction-1/interaction-token/callback",
      );
      expect(normalizeGeneratedDiscordIdBytes(loopback.requests[0]?.body ?? "")).toBe(
        JSON.stringify({ type: InteractionResponseType.Modal, data: expectedSerialized }),
      );
    } finally {
      await loopback.close();
    }
  });

  it.each([
    ["no preceding row", [], [1]],
    ["four preceding buttons", buttonBlock(4), [5]],
    ["five preceding buttons", buttonBlock(5), [5, 1]],
    [
      "preceding select",
      [
        {
          type: "actions" as const,
          select: {
            type: "string" as const,
            options: [{ label: "One", value: "one" }],
          },
        },
      ],
      [1, 1],
    ],
  ] satisfies Array<[string, DiscordComponentBlock[], number[]]>)(
    "keeps the modal trigger row placement after %s",
    (_label, blocks, expectedSizes) => {
      const result = buildDiscordComponentMessage({
        spec: {
          blocks: [...blocks],
          modal: { title: "Details", fields: [{ type: "text", label: "Name" }] },
        },
      });
      const container = result.components[0];
      if (!(container instanceof Container)) {
        throw new Error("Expected a Discord component container");
      }
      const rows = container.components.filter((component) => component instanceof Row);
      expect(rows.map((row) => row.components.length)).toEqual(expectedSizes);
      expect(rows.at(-1)?.components.at(-1)?.type).toBe(ComponentType.Button);
    },
  );
});
