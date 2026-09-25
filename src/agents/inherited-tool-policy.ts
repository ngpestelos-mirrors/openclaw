import { isFrozenClawToolAllowPolicy } from "../claws/tool-policy-runtime.js";
import { areDelegatedToolParametersCompatible } from "./inherited-tool-parameters.js";
import type { DelegatedToolParameterPolicy } from "./inherited-tool-parameters.types.js";
import {
  conjoinInheritedToolPolicies,
  parseInheritedToolPolicyV2,
  type InheritedToolPolicyClause,
  type InheritedToolPolicyV2,
} from "./inherited-tool-policy.schema.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import { createToolExecutionMatcher } from "./tool-policy-shared.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  readToolAllowlistIntersection,
  type ToolPolicyLike,
} from "./tool-policy.js";

/** Capture each conjunction before catalog filtering, including non-enumerable hook intersections. */
export function captureInheritedToolPolicy(params: {
  policies: readonly (ToolPolicyLike | undefined)[];
  inherited?: InheritedToolPolicyV2;
  runtimeAllow?: string[];
  executionAllow?: readonly string[];
  restartSafe?: boolean;
  parameters: DelegatedToolParameterPolicy;
}): InheritedToolPolicyV2 {
  const clauses: InheritedToolPolicyClause[] = [];
  for (const policy of params.policies) {
    if (!policy) {
      continue;
    }
    const frozenAllow = isFrozenClawToolAllowPolicy(policy);
    const intersection = policy.allow && readToolAllowlistIntersection(policy.allow);
    if (intersection) {
      if (policy.deny?.length) {
        clauses.push({ kind: "configured", deny: policy.deny });
      }
      for (const allow of intersection) {
        // An empty intersection operand means no tools; an ordinary empty
        // configured allowlist retains its established unrestricted meaning.
        clauses.push(
          allow.length === 0
            ? { kind: "runtime", allow: [] }
            : {
                kind: "configured",
                allow,
                ...(frozenAllow ? { frozenAllow: true } : {}),
              },
        );
      }
    } else {
      clauses.push({
        kind: "configured",
        allow: policy.allow,
        deny: policy.deny,
        ...(frozenAllow ? { frozenAllow: true } : {}),
      });
    }
  }
  if (params.runtimeAllow !== undefined) {
    for (const allow of readToolAllowlistIntersection(params.runtimeAllow) ?? [
      params.runtimeAllow,
    ]) {
      clauses.push({
        kind: "runtime",
        allow,
      });
    }
  }
  if (params.executionAllow !== undefined) {
    clauses.push({ kind: "execution", allow: [...params.executionAllow] });
  }
  if (params.restartSafe) {
    clauses.push({ kind: "restart-safe" });
  }
  const captured = parseInheritedToolPolicyV2({ clauses, parameters: params.parameters });
  return params.inherited ? conjoinInheritedToolPolicies([params.inherited, captured]) : captured;
}

type NamedTool = { name: string };
type ToolMetadata = { pluginId: string };

function configuredMatcher(
  clause: Extract<InheritedToolPolicyClause, { kind: "configured" }>,
  tool: NamedTool,
  meta?: ToolMetadata,
) {
  const groups = buildPluginToolGroups({ tools: [tool], toolMeta: () => meta });
  const expanded = expandPolicyWithPluginGroups(clause, groups);
  return createToolPolicyMatcher(
    clause.frozenAllow ? { allow: clause.allow, deny: expanded?.deny } : expanded,
  )(tool.name);
}

/** The restart predicate comes from the concrete tool owner, never from a saved list of names. */
export function createInheritedToolPolicyMatcher<T extends NamedTool>(params: {
  policy: InheritedToolPolicyV2;
  toolMeta?: (tool: T) => ToolMetadata | undefined;
  restartSafe?: (tool: T) => boolean;
}): (tool: T) => boolean {
  const matchers = params.policy.clauses.map((clause): ((tool: T) => boolean) => {
    switch (clause.kind) {
      case "configured":
        return (tool) => configuredMatcher(clause, tool, params.toolMeta?.(tool));
      case "runtime": {
        if (clause.allow.length === 0) {
          return () => false;
        }
        if (clause.allow.includes("*")) {
          return () => true;
        }
        return (tool) =>
          configuredMatcher({ ...clause, kind: "configured" }, tool, params.toolMeta?.(tool));
      }
      case "execution": {
        const matches = createToolExecutionMatcher(clause.allow);
        return (tool) => matches(tool.name);
      }
      case "restart-safe":
        return (tool) => params.restartSafe?.(tool) === true;
    }
    throw new Error("Unknown delegated tool policy clause.");
  });
  return (tool) => matchers.every((matches) => matches(tool));
}

function closedToolNames(policy: InheritedToolPolicyV2): string[] | undefined {
  for (const clause of policy.clauses) {
    if (clause.kind === "execution") {
      return clause.allow;
    }
    if (clause.kind === "configured" && clause.deny?.includes("*")) {
      return [];
    }
    if (clause.kind === "runtime" && clause.allow.length === 0) {
      return [];
    }
  }
  return undefined;
}

function clauseImplies(
  target: InheritedToolPolicyClause,
  source: InheritedToolPolicyClause,
): boolean {
  if (target.kind === "configured" && source.kind === "configured") {
    if (target.frozenAllow !== source.frozenAllow) {
      return false;
    }
    return (
      (!source.allow ||
        source.allow.includes("*") ||
        Boolean(target.allow?.every((name) => source.allow?.includes(name)))) &&
      (source.deny ?? []).every((name) => target.deny?.includes(name))
    );
  }
  if (
    (target.kind === "runtime" && source.kind === "runtime") ||
    (target.kind === "execution" && source.kind === "execution")
  ) {
    return (
      (source.kind === "runtime" && source.allow.includes("*")) ||
      target.allow.every((name) => source.allow.includes(name))
    );
  }
  return target.kind === "restart-safe" && source.kind === "restart-safe";
}

/** Without concrete metadata, plugin selectors cannot exclude a possible target action. */
function upperBoundToolPolicy(policy: InheritedToolPolicyV2): InheritedToolPolicyV2 {
  return {
    ...policy,
    clauses: policy.clauses.flatMap((clause): InheritedToolPolicyClause[] => {
      if (clause.kind === "execution" || (clause.kind === "runtime" && !clause.allow.length)) {
        return [clause];
      }
      return clause.kind === "configured" && clause.deny?.length
        ? [{ kind: "configured", deny: clause.deny }]
        : [];
    }),
  };
}

function permitsWithoutToolMetadata(clause: InheritedToolPolicyClause): boolean {
  // Plugin membership can add a deny match. Positive allow matches remain
  // valid when a selector expands to the concrete tool's own name.
  return (
    clause.kind === "execution" ||
    clause.kind === "runtime" ||
    (clause.kind === "configured" && !clause.deny?.length)
  );
}

/** Proves target actions are a subset; uncertainty never authorizes an in-context injection. */
export function assertInheritedToolPolicyCompatible(params: {
  source: InheritedToolPolicyV2;
  target: InheritedToolPolicyV2;
  targetEnforcedParameters?: InheritedToolPolicyV2["parameters"];
}): void {
  const source = parseInheritedToolPolicyV2(params.source);
  const target = parseInheritedToolPolicyV2(params.target);
  const finite = closedToolNames(target);
  const targetNames = upperBoundToolPolicy(target);
  const targetMatches = createInheritedToolPolicyMatcher({ policy: targetNames });
  for (const clause of source.clauses) {
    if (target.clauses.some((targetClause) => clauseImplies(targetClause, clause))) {
      continue;
    }
    const matches = createInheritedToolPolicyMatcher({ policy: { ...source, clauses: [clause] } });
    if (
      finite !== undefined &&
      finite.every(
        (name) =>
          !targetMatches({ name }) || (permitsWithoutToolMetadata(clause) && matches({ name })),
      )
    ) {
      continue;
    }
    throw new Error(
      "The target task's action restrictions do not satisfy this request. Use an independent task for an assessment, or an authorized conversation to control the active task.",
    );
  }
  const allows = (name: string) => targetMatches({ name });
  const compatible = areDelegatedToolParametersCompatible(
    source.parameters,
    target.parameters,
    {
      exec: allows("exec"),
      fileTools: ["read", "write", "edit", "apply_patch"].some(allows),
      fileWrites: ["write", "edit", "apply_patch"].some(allows),
      applyPatch: allows("apply_patch"),
      sandbox: ["exec", "read", "write", "edit", "apply_patch", "browser"].some(allows),
    },
    params.targetEnforcedParameters,
  );
  if (!compatible.compatible) {
    throw new Error(compatible.reason);
  }
}
