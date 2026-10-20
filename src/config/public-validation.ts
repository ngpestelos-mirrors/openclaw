import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "../commands/doctor/shared/legacy-config-migrations.runtime.skills.js";
import { formatConcreteConfigPath, tokenizeConcreteConfigPath } from "../shared/dot-path.js";
import { classifyConfigSchemaPathSegment } from "./schema.lookup.js";
import type { ConfigValidationIssue } from "./types.js";

const TYPE =
  "string|number|boolean|object|array|null|undefined|bigint|symbol|function|date|nan|int";
const typeIssue = new RegExp(
  `^(?:Invalid input: )?expected (${TYPE}), (?:received|got) (${TYPE})$`,
  "u",
);
const diagnosticLine = new RegExp(
  `^(?:- )?(?:.+:\\d+ — )?(.+?): (Invalid configuration field|missing required|(?:Invalid input: )?expected (?:${TYPE}), (?:received|got) (?:${TYPE})|Unrecognized keys?: .+|unrecognized key (?:<key>|[A-Za-z][A-Za-z0-9]*))$`,
  "u",
);
const retiredSkillPaths = LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS.flatMap((migration) =>
  (migration.legacyRules ?? []).map((rule) => rule.path),
);

/** Public issues contain validator vocabulary, never rejected values or arbitrary messages. */
export function publicConfigIssueMessage(
  issue: Pick<ConfigValidationIssue, "path" | "message">,
): string {
  const mismatch = typeIssue.exec(issue.message);
  if (mismatch) {
    return mismatch[2] === "undefined"
      ? "missing required"
      : `expected ${mismatch[1]}, got ${mismatch[2]}`;
  }
  if (issue.message === "missing required" || issue.message === "Invalid configuration field") {
    return issue.message;
  }
  const keys = /^(?:Unrecognized keys?: (.+)|unrecognized key (.+))$/u.exec(issue.message);
  if (keys) {
    let names: unknown;
    try {
      names = JSON.parse(`[${keys[1]}]`);
    } catch {
      names = [keys[2]];
    }
    const name = Array.isArray(names) && names.length === 1 ? names[0] : undefined;
    const known =
      typeof name === "string" &&
      retiredSkillPaths.some((parts) => parts.join(".") === `${issue.path}.${name}`);
    return `unrecognized key ${known ? name : "<key>"}`;
  }
  return "Invalid configuration field";
}

/** Core and bundled schemas are public vocabulary; installed plugin schemas are not. */
export async function projectPublicConfigKey(value: string): Promise<string> {
  if (value === "<root>" || !value) {
    return "<root>";
  }
  let parts: Array<string | number>;
  try {
    parts = tokenizeConcreteConfigPath(value).tokens;
  } catch {
    return "[redacted-key]";
  }
  if (parts.length > 32) {
    return "[redacted-key]";
  }
  const [{ buildConfigSchemaCore }, { LEGACY_CONFIG_MIGRATION_RULES }] = await Promise.all([
    import("./schema.js"),
    import("../commands/doctor/shared/legacy-config-migrations.js"),
  ]);
  const legacyPaths = LEGACY_CONFIG_MIGRATION_RULES.map((rule) => rule.path);
  const schema = buildConfigSchemaCore();
  const parent: string[] = [];
  const projected: string[] = [];
  for (const part of parts) {
    const segment = String(part);
    const kind = classifyConfigSchemaPathSegment(schema, parent, segment);
    const legacy = legacyPaths.some(
      (path) =>
        parent.every((item, index) => item === path[index]) && path[parent.length] === segment,
    );
    projected.push(
      kind === "property" || kind === "array-index" || legacy
        ? segment
        : kind === "record-key" || kind === "invalid-record-key"
          ? "<id>"
          : "<key>",
    );
    parent.push(segment);
  }
  return projected.join(".").slice(0, 128);
}

/** Admission protocol 1 carries fixed issue kinds as lines rather than structured facts. */
export function parsePublicConfigDiagnosticLines(
  value: string,
): Array<{ path: string; message: string }> {
  const lines: Array<{ path: string; message: string }> = [];
  for (const line of value.split(/[\r\n\u2028\u2029]|; /u)) {
    const issue = diagnosticLine.exec(line);
    if (!issue?.[1] || !issue[2]) {
      continue;
    }
    const message = publicConfigIssueMessage({ path: issue[1], message: issue[2] });
    lines.push({ path: issue[1], message });
  }
  return lines;
}

export async function projectPublicConfigDiagnosticLines(value: string): Promise<string[]> {
  return await Promise.all(
    parsePublicConfigDiagnosticLines(value).map(
      async (issue) => `${await projectPublicConfigKey(issue.path)}: ${issue.message}`,
    ),
  );
}

export function configIssueFactPath(
  issue: Pick<ConfigValidationIssue, "path" | "pathSegments">,
): string {
  return issue.pathSegments?.length
    ? formatConcreteConfigPath(issue.pathSegments)
    : issue.path || "<root>";
}
