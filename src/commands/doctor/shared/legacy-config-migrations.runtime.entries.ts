import { applyImplicitAgentRosterDefaults } from "../../../config/implicit-agent-roster.js";
import { retainLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import {
  materializeLegacyDefaultAgentRoles,
  resolveLegacyFirstAgentWorkspacePin,
} from "../../../config/legacy.default-agent-roles.js";
import { projectLegacyAgentRosterEntries } from "../../../config/legacy.roster.js";
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigMigrationContext,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

function migrateAgentEntries(
  raw: Record<string, unknown>,
  changes: string[],
  context?: LegacyConfigMigrationContext,
): void {
  const agents = getRecord(raw.agents);
  if (
    !agents ||
    !Object.prototype.propertyIsEnumerable.call(agents, "list") ||
    !Array.isArray(agents.list)
  ) {
    return;
  }
  if (Object.hasOwn(agents, "entries")) {
    if (getRecord(agents.entries)) {
      delete agents.list;
      changes.push("Removed agents.list because canonical agents.entries is already set.");
    }
    return;
  }
  const projected = projectLegacyAgentRosterEntries(agents.list);
  changes.push(...projected.diagnostics);
  const orderedEntries = projected.entries.map(({ config }) => config);
  const workspace = resolveLegacyFirstAgentWorkspacePin(agents, orderedEntries, context);
  if (workspace !== undefined) {
    orderedEntries[0]!.workspace = workspace;
  }
  agents.entries = Object.fromEntries(projected.entries.map(({ id, config }) => [id, config]));
  delete agents.list;
  Object.assign(raw, applyImplicitAgentRosterDefaults(raw));
  changes.push("Moved agents.list → keyed agents.entries.");
}

export const LEGACY_AGENT_ROSTER_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "list"],
    match: (_value, root) =>
      Object.prototype.propertyIsEnumerable.call(getRecord(root.agents), "list"),
    message: 'agents.list moved to keyed agents.entries. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents", "entries"],
    match: (value) =>
      Object.values(getRecord(value) ?? {}).some((entry) => {
        const record = getRecord(entry);
        return record !== null && typeof record.default === "boolean";
      }),
    message:
      'Legacy agents.entries default markers need explicit surface owners. Run "openclaw doctor --fix".',
  },
];

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "runtime.agents-entries",
    describe: "Move agent arrays to keyed entries",
    legacyRules: LEGACY_AGENT_ROSTER_RULES,
    apply: migrateAgentEntries,
  }),
  defineLegacyConfigMigration({
    id: "runtime.agents-explicit-ownership",
    describe: "Persist canonical roster and per-surface ownership",
    apply: (raw, changes, context) => {
      const agents = getRecord(raw.agents);
      const entries = getRecord(agents?.entries);
      if (!agents || !entries) {
        return;
      }
      const roster = Object.entries(entries);
      if (
        roster.some(([, entry]) => {
          const record = getRecord(entry);
          return (
            !record || (Object.hasOwn(record, "default") && typeof record.default !== "boolean")
          );
        })
      ) {
        return;
      }
      const marked = roster.filter(([, entry]) => getRecord(entry)?.default === true);
      if (marked.length > 1 || (marked.length > 0 && agents.ownership === "explicit")) {
        return;
      }
      const legacyOwner = roster.length > 1 ? marked[0]?.[0] : undefined;
      if (legacyOwner) {
        const materialized = materializeLegacyDefaultAgentRoles(
          raw as OpenClawConfig,
          legacyOwner,
          { ...context, materializeWorkspace: true },
        );
        Object.assign(raw, materialized.config);
        retainLegacyDefaultAgentId(raw as OpenClawConfig, legacyOwner);
        changes.push("Preserved legacy per-surface agent ownership and workspace.");
      }
      const nextAgents = getRecord(raw.agents)!;
      const nextEntries = getRecord(nextAgents.entries)!;
      for (const entry of Object.values(nextEntries)) {
        const record = getRecord(entry)!;
        if (Object.hasOwn(record, "default")) {
          delete record.default;
          changes.push("Removed retired agents.entries default marker.");
        }
      }
      if (roster.length < 2 || nextAgents.ownership !== undefined) {
        return;
      }
      // Recovery validates the registry's candidate before the later Doctor config flow.
      nextAgents.ownership = "explicit";
      changes.push("Stamped the multi-agent roster for explicit per-surface ownership.");
    },
  }),
];
