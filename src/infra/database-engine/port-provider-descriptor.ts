import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { requireDatabasePortProvider } from "./port-provider.js";

/** Offline operations retain the selected plugin's source/build family for owner callbacks. */
export async function loadDatabasePortDescriptor(id: string, config: OpenClawConfig = {}) {
  const provider = requireDatabasePortProvider(id);
  const owner = resolvePluginMetadataSnapshot({ config }).byPluginId.get(id);
  return provider.loadDescriptor(owner);
}
