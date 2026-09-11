import type { ModelAllowList } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";

export function formatModelsAllowListNotice(
  facts: ModelAllowList | undefined,
  hasModels: boolean,
): string {
  if (!facts) {
    return "";
  }
  const lines = [
    ...(facts.hiddenCount > 0
      ? [`${facts.hiddenCount} newer models hidden by your allow list`]
      : []),
    ...(!hasModels ? ["No models match your allow list."] : []),
    ...(facts.selectedModelBlocked ? ["The pinned model is not in your allow list."] : []),
  ];
  return lines.length ? [...lines, `Settings: ${facts.settingsPath}`].join("\n") : "";
}
