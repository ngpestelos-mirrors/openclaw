import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { build } from "esbuild";
import { format } from "oxfmt";
import { IsLiteralString, ObjectOptions, Type, type TSchema } from "typebox";
import * as Compiler from "typebox/schema";
import { AgentRuntimeRestrictionErrorDetailsSchema } from "../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import {
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
} from "../packages/gateway-protocol/src/schema/approvals.js";
import { BoardSnapshotSchema } from "../packages/gateway-protocol/src/schema/board.js";
import { CommandsListResultSchema } from "../packages/gateway-protocol/src/schema/commands.js";
import {
  AgentActivityItemSchema,
  AgentActivityDelegationSchema,
  ChatHistoryParamsSchema,
  ChatPendingInputsPageSchema,
} from "../packages/gateway-protocol/src/schema/logs-chat.js";
import { ProgressCardSchema } from "../packages/gateway-protocol/src/schema/progress-card.js";
import { SessionParticipantIdentitySchema } from "../packages/gateway-protocol/src/schema/session-participant.js";
import { SessionsCreateParamsSchema } from "../packages/gateway-protocol/src/schema/sessions-create.js";
import {
  SessionsGoalClearParamsSchema,
  SessionsGoalUpdateParamsSchema,
} from "../packages/gateway-protocol/src/schema/sessions-goal.js";
import { SessionReactionEventSchema } from "../packages/gateway-protocol/src/schema/sessions-reactions.js";
import {
  SessionPermissionModeSchema,
  SessionRowSchema,
  SessionToolOverridesSchema,
} from "../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  SessionNarrationEventSchema,
  SessionObserverDigestSchema,
} from "../packages/gateway-protocol/src/schema/sessions.js";
import { TalkVoiceChangeEventSchema } from "../packages/gateway-protocol/src/schema/talk-voice.js";
import { CHAT_TRANSCRIPT_METADATA_KEYS } from "../ui/src/pages/chat/chat-transcript-metadata.ts";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";
import {
  assertStandaloneValidatorSource,
  emitStandaloneValidatorSource,
  standaloneValidatorHeader,
} from "./lib/typebox-standalone.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputBase = "ui/src/lib/protocol-validators.generated";
const schemaRoot = "../../../../packages/gateway-protocol/src/schema/";
type Group =
  | "activity"
  | "approvals"
  | "session-input"
  | "transcript"
  | "board"
  | "history-state"
  | "sender-identity";
const additionalLintRules: Partial<Record<Group, string[]>> = {
  activity: ["eslint/curly"],
  approvals: ["unicorn/no-useless-length-check"],
};
const validators: Array<[name: string, schema: TSchema, type: string, group: Group]> = [
  [
    "BoardSnapshot",
    BoardSnapshotSchema,
    'import("' + schemaRoot + 'board.js").BoardSnapshot',
    "board",
  ],
  [
    "SessionParticipantIdentity",
    SessionParticipantIdentitySchema,
    'import("../schema/session-participant.js").SessionParticipantIdentity',
    "sender-identity",
  ],
  [
    "AgentActivityItem",
    AgentActivityItemSchema,
    'import("' + schemaRoot + 'logs-chat.js").AgentActivityItem',
    "activity",
  ],
  [
    "AgentRuntimeRestrictionErrorDetails",
    AgentRuntimeRestrictionErrorDetailsSchema,
    'import("../../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js").AgentRuntimeRestrictionErrorDetails',
    "session-input",
  ],
  [
    "SessionObserverDigest",
    SessionObserverDigestSchema,
    'import("' + schemaRoot + 'sessions.js").SessionObserverDigest',
    "activity",
  ],
  [
    "SessionNarrationEvent",
    SessionNarrationEventSchema,
    'import("' + schemaRoot + 'sessions.js").SessionNarrationEvent',
    "activity",
  ],
  [
    "SessionReactionEvent",
    SessionReactionEventSchema,
    'import("' + schemaRoot + 'sessions-reactions.js").SessionReactionEvent',
    "activity",
  ],
  [
    "SessionApprovalEvent",
    SessionApprovalEventSchema,
    'import("' + schemaRoot + 'approvals.js").SessionApprovalEvent',
    "approvals",
  ],
  [
    "SessionApprovalReplay",
    SessionApprovalReplaySchema,
    'import("' + schemaRoot + 'approvals.js").SessionApprovalReplay',
    "approvals",
  ],
  [
    "SessionsGoalUpdateParams",
    SessionsGoalUpdateParamsSchema,
    'import("' + schemaRoot + 'sessions-goal.js").SessionsGoalUpdateParams',
    "session-input",
  ],
  [
    "SessionsGoalClearParams",
    SessionsGoalClearParamsSchema,
    'import("' + schemaRoot + 'sessions-goal.js").SessionsGoalClearParams',
    "session-input",
  ],
  ...(["worktreeSource", "deviceFolder", "repository", "fastMode", "titleSource"] as const).map(
    (key): [string, TSchema, string, Group] => [
      `Session${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      SessionsCreateParamsSchema.properties[key],
      `import("${schemaRoot}sessions-create.js").SessionsCreateParams["${key}"]`,
      "session-input",
    ],
  ),
  [
    "SessionPermissionMode",
    SessionPermissionModeSchema,
    'import("' + schemaRoot + 'sessions-row.js").SessionPermissionMode',
    "session-input",
  ],
  [
    "SessionToolOverrides",
    SessionToolOverridesSchema,
    'import("' + schemaRoot + 'sessions-row.js").SessionToolOverrides',
    "session-input",
  ],
  [
    "ChatHistoryState",
    Type.Object(
      {
        stateRevision: Type.Required(ChatHistoryParamsSchema).properties.knownState,
        pendingInputs: Type.Optional(ChatPendingInputsPageSchema),
        sessionInfo: Type.Optional(SessionRowSchema),
        commands: Type.Optional(CommandsListResultSchema.properties.commands),
      },
      { additionalProperties: false },
    ),
    'import("../../pages/chat/chat-transcript-metadata.ts").ChatHistoryState',
    "history-state",
  ],
  [
    "ChatTranscriptMetadata",
    Type.Pick(SessionRowSchema, CHAT_TRANSCRIPT_METADATA_KEYS),
    'import("../../pages/chat/chat-transcript-metadata.ts").ChatTranscriptMetadata',
    "transcript",
  ],
  [
    "ProgressCard",
    ProgressCardSchema,
    'import("' + schemaRoot + 'progress-card.js").ProgressCard',
    "transcript",
  ],
  [
    "TalkVoiceChangeEvent",
    TalkVoiceChangeEventSchema,
    'import("' + schemaRoot + 'talk-voice.js").TalkVoiceChangeEvent',
    "session-input",
  ],
];

function compile(name: string, schema: TSchema, imports: Set<string>): string {
  const compiled = Compiler.Build(schema);
  if (compiled.UseUnevaluated()) {
    throw new Error(`${name}: unevaluated schemas need an explicit standalone implementation`);
  }
  const emitted = emitStandaloneValidatorSource(
    `is${name}`,
    compiled.Functions().join(";\n"),
    compiled.External().variables,
    `value => ${compiled.Entry()}`,
  );
  for (const statement of emitted.imports) {
    imports.add(statement);
  }
  return emitted.source;
}

function onlyStringUniqueItems(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return true;
  }
  if (
    "uniqueItems" in value &&
    value.uniqueItems === true &&
    !(Type.IsArray(value) && Type.IsUnion(value.items) && value.items.anyOf.every(IsLiteralString))
  ) {
    return false;
  }
  return Object.values(value).every(onlyStringUniqueItems);
}

function removeStringEnumHashing(source: string): string {
  type Node = { type: string; start: number; end: number; [key: string]: unknown };
  const isNode = (value: unknown): value is Node =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number";
  const isIdentifier = (value: unknown, name: string): boolean =>
    isNode(value) && value.type === "Identifier" && value.name === name;
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    if (isNode(value) && value.type === "CallExpression") {
      const callee = value.callee;
      const argument =
        Array.isArray(value.arguments) && value.arguments.length === 1
          ? value.arguments[0]
          : undefined;
      if (
        isNode(callee) &&
        callee.type === "MemberExpression" &&
        !callee.computed &&
        isIdentifier(callee.property, "map") &&
        isNode(callee.object) &&
        isNode(argument) &&
        argument.type === "MemberExpression" &&
        !argument.computed &&
        isIdentifier(argument.object, "Hashing") &&
        isIdentifier(argument.property, "Hash")
      ) {
        ranges.push({ start: callee.object.end, end: value.end });
      }
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  let rewritten = source;
  for (const { start, end } of ranges.toSorted((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, start) + rewritten.slice(end);
  }
  return rewritten;
}

function compileShared(entries: typeof validators, imports: Set<string>): string {
  const sharedSchema = Compiler.Intern(
    Type.Object(Object.fromEntries(entries.map(([name, schema]) => [name, schema]))),
  );
  const root = sharedSchema.$defs[sharedSchema.$ref.slice("#/$defs/".length)];
  if (!root || !Compiler.IsProperties(root) || Compiler.HasUnevaluated({}, sharedSchema)) {
    throw new Error("Shared validators need a standalone object schema without unevaluated checks");
  }
  // Match Build's reset boundary while sharing one scope across the group entry points.
  Compiler.ResetExternal();
  Compiler.ResetFunctions();
  const context = new Compiler.BuildContext(false);
  const stack = Compiler.Stack({}, sharedSchema);
  const entriesSource = Object.entries(root.properties).map(
    ([name, entry]) =>
      `is${name}: value => ${Compiler.CreateFunction(stack, context, entry, "value")}`,
  );
  let functions = Compiler.GetFunctions().join(";\n");
  if (entries.every(([, schema]) => onlyStringUniqueItems(schema))) {
    // These finite string enums have the same equality under Set and TypeBox hashing.
    functions = removeStringEnumHashing(functions);
  }
  const emitted = emitStandaloneValidatorSource(
    `{ ${entries.map(([name]) => `is${name}`).join(", ")} }`,
    functions,
    Compiler.GetExternal().variables,
    `{ ${entriesSource.join(", ")} }`,
  );
  for (const statement of emitted.imports) {
    imports.add(statement);
  }
  return emitted.source;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: pnpm ui:validators:gen [--check]");
  }
  // Activity receipts are the only nested record; keep their cleaner schema-derived too.
  for (const schema of [AgentActivityItemSchema, AgentActivityDelegationSchema]) {
    if (ObjectOptions(schema).additionalProperties !== false) {
      throw new Error("Activity cleaners require closed records");
    }
  }
  const cleaner = `const activityKeys = new Set(${JSON.stringify(Object.keys(AgentActivityItemSchema.properties))});
    const delegationKeys = new Set(${JSON.stringify(Object.keys(AgentActivityDelegationSchema.properties))});
    function cleanRecord(value, keys) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      for (const key of Object.getOwnPropertyNames(value)) {
        if (!keys.has(key)) delete value[key];
      }
      return value;
    }
    export function cleanAgentActivityItem(value) {
      cleanRecord(value, activityKeys);
      if (value && typeof value === "object" && Array.isArray(value.delegation)) {
        for (const receipt of value.delegation) cleanRecord(receipt, delegationKeys);
      }
      return value;
    }`;
  for (const group of [
    "activity",
    "approvals",
    "session-input",
    "transcript",
    "history-state",
    "sender-identity",
    "board",
  ] as const) {
    const selected = validators.filter((entry) => entry[3] === group);
    const imports = new Set<string>();
    // Share repeated shapes only within each existing lazy boundary.
    const compiled = ["activity", "approvals", "session-input"].includes(group)
      ? compileShared(selected, imports)
      : selected
          .map(([name, schema]) =>
            compile(
              name,
              name === "ChatHistoryState" || name === "ChatTranscriptMetadata"
                ? Compiler.Intern(schema)
                : schema,
              imports,
            ),
          )
          .join("\n");
    // Import the compiler's exact helpers by name so one scalar check does not bundle every guard.
    const source = [...imports, compiled, ...(group === "activity" ? [cleaner] : [])].join("\n");
    const result = await build({
      stdin: { contents: source, resolveDir: repoRoot, loader: "js" },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      minifySyntax: true,
      // Remove esbuild's physical input-path banners before canonical formatting.
      // The TypeBox license is retained explicitly below.
      minifyWhitespace: true,
      legalComments: "none",
    });
    const outputFile = result.outputFiles[0];
    if (!outputFile) {
      throw new Error(`${group}: standalone validator build emitted no output`);
    }
    const runtime = outputFile.text;
    assertStandaloneValidatorSource(runtime);
    const declaration = selected
      .map(([name, , type]) => `export function is${name}(value: unknown): value is ${type};`)
      .concat(
        group === "activity"
          ? ["export function cleanAgentActivityItem(value: unknown): unknown;"]
          : [],
      )
      .join("\n");
    for (const [extension, contents] of [
      ["js", runtime],
      ["d.ts", declaration],
    ]) {
      const outputPath =
        group === "sender-identity"
          ? `packages/gateway-protocol/src/compiled/sender-identity.${extension}`
          : `${outputBase}/${group}.${extension}`;
      const generatedHeader = standaloneValidatorHeader("pnpm ui:validators:gen", {
        declaration: extension === "d.ts",
        additionalLintRules: additionalLintRules[group],
      });
      const formatted = await format(outputPath, generatedHeader + contents);
      if (formatted.errors.length) {
        throw new Error(`Cannot format ${outputPath}: ${JSON.stringify(formatted.errors)}`);
      }
      const output = writeGeneratedOutput({
        check: args.includes("--check"),
        next: formatted.code,
        outputPath,
        repoRoot,
      });
      if (args.includes("--check") && output.changed) {
        throw new Error(`${outputPath} is stale; run pnpm ui:validators:gen`);
      }
      console.log(`[ui:validators] ${output.changed ? "updated" : "unchanged"} ${outputPath}`);
    }
  }
}

await main();
