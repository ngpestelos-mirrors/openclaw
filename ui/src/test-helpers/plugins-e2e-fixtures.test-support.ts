import type { PluginDiscoveryEntry, PluginDiscoveryResult } from "../lib/plugins/index.ts";

function installedDisabled(pluginId: string): PluginDiscoveryEntry["local"] {
  return {
    present: true,
    installed: true,
    enabled: false,
    state: "disabled",
    pluginId,
    action: "manage",
  };
}

const memoryDiscoveryPlugin = {
  id: "ch_bWVtb3J5LXBsdXM",
  catalog: {
    name: "Memory Plus",
    summary: "Long-term memory for people and projects.",
    family: "code-plugin",
    author: "alice",
    official: false,
    categories: ["memory"],
    downloads: 1240,
  },
  local: installedDisabled("memory-plus"),
} satisfies PluginDiscoveryEntry;

export const matrixDiscoveryPlugin = {
  ...memoryDiscoveryPlugin,
  id: "ch_bWF0cml4",
  catalog: {
    ...memoryDiscoveryPlugin.catalog,
    name: "Matrix",
    summary: "Connect agents to Matrix rooms.",
    author: "openclaw",
    categories: ["channels"],
    downloads: 52_201,
    icon: "message-circle",
    official: true,
  },
  local: {
    present: false,
    installed: false,
    enabled: false,
    state: "not-installed",
    action: "install",
  },
} satisfies PluginDiscoveryEntry;

const telegramDiscoveryPlugin = {
  ...matrixDiscoveryPlugin,
  id: "ch_QG9wZW5jbGF3L3RlbGVncmFt",
  catalog: {
    ...matrixDiscoveryPlugin.catalog,
    name: "Telegram",
    summary: "Chat with your agent from Telegram groups and direct messages.",
    author: "openclaw",
    downloads: 12_847,
  },
  local: installedDisabled("telegram"),
} satisfies PluginDiscoveryEntry;

export const localOnlyDiscoveryPlugin = {
  id: "local_QG9wZW5jbGF3L2xvY2FsLWNhbGVuZGFy",
  catalog: {
    name: "Local Calendar",
    summary: "Coordinate work using the included calendar plugin.",
    official: false,
    categories: ["scheduling"],
    latestVersion: "1.0.0",
    publishedToClawHub: false,
  },
  local: {
    present: true,
    installed: false,
    enabled: false,
    state: "not-installed",
    pluginId: "local-calendar",
    install: { source: "official", pluginId: "local-calendar" },
    action: "install",
  },
} satisfies PluginDiscoveryEntry;

function availableDiscoveryPlugin(index: number, prefix: string): PluginDiscoveryEntry {
  return {
    ...matrixDiscoveryPlugin,
    id: `ch_${prefix.toLowerCase().replaceAll(" ", "-")}_${index}`,
    catalog: {
      ...matrixDiscoveryPlugin.catalog,
      name: `${prefix} ${String(index).padStart(2, "0")}`,
      summary: `Catalog fixture ${prefix.toLowerCase()} ${index}.`,
      author: "publisher",
      official: false,
      downloads: 1_000 + index,
    },
  };
}

export const secondDiscoveryPageItems = Array.from({ length: 25 }, (_, index) =>
  availableDiscoveryPlugin(index, "Second page"),
);

export const finalDiscoveryPageItems = [
  {
    ...matrixDiscoveryPlugin,
    id: "ch_c2xhY2s",
    catalog: { ...matrixDiscoveryPlugin.catalog, name: "Slack" },
  },
  availableDiscoveryPlugin(0, "Final page"),
] satisfies PluginDiscoveryEntry[];

const discoveryCategoryDefinitions = [
  ["channels", "Channels", "Messaging.", "message-circle"],
  ["models", "Models", "Model providers.", "brain"],
  ["agent-runtimes", "Agent runtimes", "Agent execution and native sessions.", "bot"],
  ["memory", "Memory", "Memory systems.", "database"],
  ["context", "Context", "Context tools.", "book-open"],
  ["voice", "Voice", "Voice tools.", "mic"],
  ["web", "Web", "Web tools.", "globe"],
  ["computer-use", "Computer use", "Computer and browser control.", "monitor"],
  ["media", "Media", "Media tools.", "palette"],
  ["security", "Security", "Security tools.", "shield"],
  ["integrations", "Integrations", "Service connectors.", "plug"],
  ["developer-tools", "Developer tools", "Software development.", "code-xml"],
  ["infrastructure", "Infrastructure", "Hosting and systems.", "server"],
  ["documents-files", "Documents & files", "Document and file workflows.", "files"],
  ["inbox-collaboration", "Inbox & collaboration", "Email and teamwork.", "inbox"],
  ["productivity", "Productivity", "Tasks and work organization.", "list-todo"],
  ["scheduling", "Scheduling", "Calendars and appointments.", "calendar-days"],
  ["finance-payments", "Finance & payments", "Accounting and payments.", "wallet-cards"],
  ["sales-marketing", "Sales & marketing", "Sales and marketing.", "megaphone"],
  ["data-analytics", "Data & analytics", "Data analysis and reporting.", "chart-no-axes-combined"],
  ["agent-orchestration", "Agent orchestration", "Agent workflows.", "workflow"],
  ["research", "Research", "Research and synthesis.", "search"],
  ["other", "Other", "Other plugins.", "package"],
] as const;

export const discoveryCategories = {
  categories: discoveryCategoryDefinitions.map(([slug, label, description, icon], order) => ({
    slug,
    label,
    description,
    icon,
    order,
  })),
};

const firstDiscoveryPageItems = Array.from({ length: 22 }, (_, index) =>
  availableDiscoveryPlugin(index, "First page"),
);

function onOverviewShelves(
  plugin: PluginDiscoveryEntry,
  featuredRank: number,
  trendingRank = featuredRank,
): PluginDiscoveryEntry {
  return {
    ...plugin,
    catalog: {
      ...plugin.catalog,
      featured: true,
      trending: true,
      featuredRank,
      trendingRank,
    },
  };
}

export const discoveryResult: PluginDiscoveryResult = {
  items: [
    localOnlyDiscoveryPlugin,
    onOverviewShelves(memoryDiscoveryPlugin, 0, 1),
    onOverviewShelves(matrixDiscoveryPlugin, 1, 0),
    telegramDiscoveryPlugin,
    ...firstDiscoveryPageItems
      .slice(0, 6)
      .map((plugin, index) => onOverviewShelves(plugin, index + 2)),
    ...firstDiscoveryPageItems.slice(6),
  ],
  categories: discoveryCategories.categories,
  nextCursor: "catalog-page-2",
};
