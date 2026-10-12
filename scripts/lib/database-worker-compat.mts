import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { SymbolFlags, type Symbol } from "typescript/unstable/sync";
import { createNativeTypeScriptProject } from "./native-typescript.mts";

// Each entry is a reviewed, released compatibility boundary, not a whole-file exemption.
// Kernels may join this list only after their bundled callers have moved to workers.
const reviewed = new Map<string, readonly string[]>([
  [
    "src/plugin-sdk/sqlite-runtime-legacy.ts",
    [
      "openOpenClawAgentDatabaseLegacy",
      "borrowOpenClawAgentDatabaseLegacy",
      "withOpenClawAgentDatabaseAsyncLegacy",
      "withOpenClawAgentDatabaseRuntimeLegacy",
      "withOpenClawAgentDatabaseWriteLegacy",
      "runOpenClawAgentWriteAdmissionLegacy",
      "executeSqliteQueryTakeFirstSyncLegacy",
      "iterateSqliteQuerySyncLegacy",
      "prepareSqliteQuerySyncLegacy",
      "runSqliteImmediateTransactionLegacy",
    ],
  ],
  ["src/sessions/session-upstream-links.ts", ["deleteSessionUpstreamLink"]],
  ["src/sessions/stored-model-overrides.ts", ["resolveStoredModelOverride"]],
  [
    "src/plugin-sdk/memory-core-host-engine-sessions.ts",
    [
      "loadArchivedSessions",
      "loadMemorySessionMetadata",
      "loadMemorySessionMetadataBatch",
      "resolveMemorySessionTargets",
    ],
  ],
  [
    "src/plugin-sdk/codex-session-transcript-runtime.ts",
    [
      "validateCodexSessionTranscriptReadAdmission",
      "validateCodexSessionTranscriptContextVersion",
      "withCodexSessionTranscriptMirrorWriteLock",
    ],
  ],
  ["src/plugin-sdk/session-transcript-runtime.ts", ["withSessionTranscriptWriteLock"]],
  ["src/plugin-sdk/session-transcript-hit.ts", ["loadCombinedSessionStoreForGateway"]],
  ["src/plugin-sdk/provider-selection-runtime.ts", ["resolveConfiguredCapabilityProvider"]],
  ["src/pairing/pairing-store.ts", ["readChannelAllowFromStoreSync"]],
  ["src/media-generation/runtime-shared.ts", ["resolveCapabilityModelCandidates"]],
  ["src/talk/provider-resolver.ts", ["resolveConfiguredRealtimeVoiceProvider"]],
  ["src/auto-reply/commands-registry.ts", ["resolveCommandArgMenu"]],
  [
    "src/channels/direct-dm-access.ts",
    ["resolveInboundDirectDmAccessWithRuntime", "createPreCryptoDirectDmAuthorizer"],
  ],
  ["src/channels/direct-dm.ts", ["dispatchInboundDirectDmWithRuntime"]],
  ["src/channels/session-envelope.ts", ["resolveInboundSessionEnvelopeContext"]],
  [
    "src/channels/inbound-event/envelope.ts",
    [
      "createInboundEnvelopeBuilder",
      "resolveInboundRouteEnvelopeBuilder",
      "resolveInboundRouteEnvelopeBuilderWithRuntime",
    ],
  ],
  ["src/security/dm-policy-shared.ts", ["resolveDmGroupAccessWithLists"]],
  [
    "src/infra/outbound/account-scoped-conversation-bindings.ts",
    ["createAccountScopedConversationBindingManager"],
  ],
  [
    "extensions/imessage/src/conversation-bindings.ts",
    ["createIMessageConversationBindingManager"],
  ],
  ["extensions/matrix/auth-presence.ts", ["hasAnyMatrixAuth"]],
  [
    "src/agents/harness/native-session/binding-lifecycle.ts",
    ["createNativeSessionBindingLifecycle"],
  ],
  [
    "src/agents/harness/native-session/binding-generation.ts",
    [
      "resolveNativeSessionBinding",
      "reclaimNativeSessionGeneration",
      "captureNativeSessionGenerationAuthority",
    ],
  ],
  [
    "src/agents/harness/native-session/binding-generation-authority.ts",
    ["resolveNativeSessionBindingWithAuthority"],
  ],
]);

// These are candidates, not exemptions: every value reference must resolve to
// another proven candidate or an inventory-reviewed worker/maintenance entry.
const nonRuntimeCandidates = new Map<string, readonly string[]>([
  ["src/state/openclaw-state-db-maintenance.ts", ["writeCurrentStateSchemaMetadata"]],
  [
    "src/state/github-publication-session-lifecycles.ts",
    ["insertGitHubPublicationSessionLifecycle"],
  ],
  ["src/state/user-github-connections.kernel.ts", ["listUserGitHubConnectionsInDatabase"]],
]);

// These exact declarations consume their inline callbacks synchronously.
const synchronousScopes = new Map<string, ReadonlyMap<string, number>>([
  ["src/infra/state-database-maintenance.ts", new Map([["withStateDatabaseSchemaMaintenance", 1]])],
  [
    "src/state/openclaw-state-db-maintenance.ts",
    new Map([["runStateSchemaMigrationTransaction", 2]]),
  ],
]);

// Installed by openclaw-state-worker-registry.ts; this table is never a host callback API.
const workerHandlers = new Map([
  [
    "src/state/user-github-connections.worker.ts",
    "userGitHubConnectionOperations.userGitHubConnections.list",
  ],
]);

type NonRuntimeTier = "T2" | "T3" | "W";

type BoundaryOperation = {
  file: string;
  name: string;
  valid: boolean;
  reviewed: boolean;
  candidate: boolean;
  nonRuntimeValid: boolean;
  entries: Set<NonRuntimeTier>;
  node: ts.FunctionDeclaration;
};

/** Prove compatibility and maintenance kernels from their complete value-reference graph. */
export function inspectDatabaseWorkerBoundaries(
  root: string,
  sourceTexts: ReadonlyMap<string, string>,
  isNonRuntime: (file: string, operation: string) => boolean = (file) =>
    /\.worker\.[cm]?[jt]s$/.test(file),
  classifyEntry: (file: string, operation: string) => NonRuntimeTier | undefined = () => undefined,
): {
  operations: Map<string, Set<string>>;
  callLocations: Map<string, Set<string>>;
  nonRuntimeOperations: Map<string, Map<string, NonRuntimeTier>>;
  nonRuntimeCallLocations: Map<string, Set<string>>;
  violations: string[];
} {
  const operations = new Map<string, Set<string>>();
  const callLocations = new Map<string, Set<string>>();
  const nonRuntimeOperations = new Map<string, Map<string, NonRuntimeTier>>();
  const nonRuntimeCallLocations = new Map<string, Set<string>>();
  const violations: string[] = [];
  if (![...reviewed.keys(), ...nonRuntimeCandidates.keys()].some((file) => sourceTexts.has(file))) {
    return { operations, callLocations, nonRuntimeOperations, nonRuntimeCallLocations, violations };
  }
  const config = ".openclaw-database-worker-compat.tsconfig.json";
  const files = Object.fromEntries(sourceTexts);
  files[config] = JSON.stringify({
    compilerOptions: {
      allowJs: true,
      noLib: true,
      types: [],
      target: "esnext",
      module: "nodenext",
      moduleResolution: "nodenext",
      jsx: "preserve",
      paths: {
        "openclaw/plugin-sdk": ["./src/plugin-sdk/index.ts"],
        "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
        "@openclaw/plugin-sdk": ["./src/plugin-sdk/index.ts"],
        "@openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
      },
    },
    files: [...sourceTexts.keys()],
    include: [],
  });
  // The supplied snapshot owns all source bytes, including historical comparisons.
  using session = createNativeTypeScriptProject({
    cwd: root,
    configFileName: config,
    files,
    fs: {
      readFile: () => null,
      fileExists: () => false,
      directoryExists: () => false,
      getAccessibleEntries: () => ({ files: [], directories: [] }),
      realpath: (file) => file,
    },
  });
  const { checker, program } = session.project;
  const forwarded = new Map<Symbol, Symbol>();
  const resolveSymbol = (symbol: Symbol | undefined): Symbol | undefined => {
    const target =
      symbol && symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return target && (forwarded.get(target) ?? target);
  };
  const isInlineInvocation = (node: ts.Node): boolean => {
    const property = node.parent;
    if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.parent)) {
      const initializer = property.parent.parent;
      const declaration = ts.isSatisfiesExpression(initializer) ? initializer.parent : initializer;
      const file = path.relative(root, node.getSourceFile().fileName).split(path.sep).join("/");
      if (
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        ts.isVariableStatement(declaration.parent.parent) &&
        ts.isSourceFile(declaration.parent.parent.parent) &&
        ts.isIdentifier(declaration.name) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        workerHandlers.get(file) === `${declaration.name.text}.${property.name.text}`
      ) {
        return true;
      }
    }
    const call = node.parent;
    if (!ts.isCallExpression(call)) {
      return false;
    }
    if (call.expression === node) {
      return true;
    }
    const symbol = resolveSymbol(checker.getSymbolAtLocation(call.expression));
    const declaration = symbol?.valueDeclaration?.resolve();
    if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.name) {
      return false;
    }
    const file = path
      .relative(root, declaration.getSourceFile().fileName)
      .split(path.sep)
      .join("/");
    const argument = synchronousScopes.get(file)?.get(declaration.name.text);
    return argument !== undefined && call.arguments[argument] === node;
  };
  const registered = new Map<Symbol, BoundaryOperation>();
  const declarations = new Map<ts.Node, BoundaryOperation>();
  const names = new Set([...reviewed.values(), ...nonRuntimeCandidates.values()].flat());
  const sources = [...sourceTexts.keys()].map((file) => {
    const source = program.getSourceFile(path.resolve(root, file));
    if (!source) {
      throw new Error(`Compatibility scan did not load ${file}`);
    }
    for (const name of [...(reviewed.get(file) ?? []), ...(nonRuntimeCandidates.get(file) ?? [])]) {
      const node = source.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === name &&
          Boolean(statement.body),
      );
      if (!node?.name) {
        continue;
      }
      const symbol = resolveSymbol(checker.getSymbolAtLocation(node.name));
      if (!symbol) {
        throw new Error(`Compatibility scan could not resolve ${file}:${name}`);
      }
      const candidate = nonRuntimeCandidates.get(file)?.includes(name) ?? false;
      const valid =
        candidate || checker.getJsDocTagsOfSymbol(symbol).some((tag) => tag.name === "deprecated");
      if (!valid) {
        violations.push(`${file}:${name}: reviewed compatibility operation must be @deprecated`);
      }
      const operation: BoundaryOperation = {
        file,
        name,
        valid,
        reviewed: true,
        candidate,
        nonRuntimeValid: true,
        entries: new Set(),
        node,
      };
      registered.set(symbol, operation);
      declarations.set(node, operation);
    }
    return { file, source };
  });
  // Follow named kernels from the reviewed boundaries. A symbol reference from
  // outside this closure (or an escaped callback) will make that kernel live.
  // Returned methods are deliberately not candidates: their receiver escapes
  // require a stronger proof than a direct function's declaration identity.
  const primitives = new Set([
    "executeSqliteQuerySync",
    "executeSqliteQueryTakeFirstSync",
    "runOpenClawStateWriteTransaction",
    "runOpenClawAgentWriteTransaction",
    "withOpenClawAgentDatabaseReadOnly",
  ]);
  const examined = new Set<Symbol>();
  let pending = [...registered.values()];
  while (pending.length > 0) {
    const references: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) {
        return;
      }
      if (ts.isCallExpression(node)) {
        references.push(node.expression);
      }
      node.forEachChild(visit);
    };
    for (const operation of pending) {
      operation.node.body?.forEachChild(visit);
    }
    pending = [];
    const symbols = checker.getSymbolAtLocation(references);
    for (const raw of symbols) {
      const symbol = resolveSymbol(raw);
      if (!symbol || examined.has(symbol) || registered.has(symbol)) {
        continue;
      }
      examined.add(symbol);
      if (primitives.has(symbol.name)) {
        continue;
      }
      const node = symbol.valueDeclaration?.resolve();
      if (!node || !ts.isFunctionDeclaration(node) || !node.name || !node.body) {
        continue;
      }
      const file = path.relative(root, node.getSourceFile().fileName).split(path.sep).join("/");
      if (!sourceTexts.has(file)) {
        continue;
      }
      const parents: string[] = [node.name.text];
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (
          (ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isMethodDeclaration(parent)) &&
          parent.name &&
          ts.isIdentifier(parent.name)
        ) {
          parents.unshift(parent.name.text);
        } else if (
          (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
          parent.initializer &&
          (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer)) &&
          ts.isIdentifier(parent.name)
        ) {
          parents.unshift(parent.name.text);
        }
      }
      const name = parents.join(".");
      if (isNonRuntime(file, name)) {
        continue;
      }
      const operation: BoundaryOperation = {
        file,
        name,
        valid: true,
        reviewed: false,
        candidate: false,
        nonRuntimeValid: true,
        entries: new Set(),
        node,
      };
      registered.set(symbol, operation);
      declarations.set(node, operation);
      names.add(node.name.text);
      pending.push(operation);
    }
  }
  const aliases: [string, string][] = [];
  const namespaces: (ts.Identifier | ts.StringLiteral)[] = [];
  const bindings: ts.VariableDeclaration[] = [];
  for (const { source } of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        aliases.push([node.propertyName?.text ?? node.name.text, node.name.text]);
      } else if (ts.isImportClause(node) && node.name) {
        aliases.push(["default", node.name.text]);
      } else if (ts.isNamespaceImport(node) || ts.isNamespaceExport(node)) {
        namespaces.push(node.name);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        bindings.push(node);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  const contained = new Map<Symbol, Set<BoundaryOperation>>();
  const targets = (rawSymbol: Symbol | undefined): Set<BoundaryOperation> => {
    const symbol = resolveSymbol(rawSymbol);
    if (!symbol) {
      return new Set();
    }
    const cached = contained.get(symbol);
    if (cached) {
      return cached;
    }
    const found = new Set<BoundaryOperation>();
    contained.set(symbol, found);
    const direct = registered.get(symbol);
    if (direct) {
      found.add(direct);
    } else if (symbol.flags & SymbolFlags.Module) {
      for (const member of checker.getExportsOfModule(symbol)) {
        for (const operation of targets(member)) {
          found.add(operation);
        }
      }
    }
    return found;
  };
  const namespaceSymbols = checker.getSymbolAtLocation(namespaces);
  for (const [index, namespace] of namespaces.entries()) {
    if (targets(namespaceSymbols[index]).size) {
      names.add(namespace.text);
    }
  }
  // Candidate spelling narrows native queries; declaration identity decides every exemption.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to] of aliases) {
      if (names.has(from) && !names.has(to)) {
        names.add(to);
        changed = true;
      }
    }
  }
  const handledImports = new Set<ts.Node>();
  for (const binding of bindings) {
    const initializer = binding.initializer!;
    const expression = ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
    const dynamicImport =
      ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.ImportKeyword
        ? expression
        : undefined;
    const module = dynamicImport?.arguments[0]
      ? resolveSymbol(checker.getSymbolAtLocation(dynamicImport.arguments[0]))
      : undefined;
    if (!dynamicImport || !module) {
      continue;
    }
    const record = (name: ts.Identifier, target: Symbol | undefined) => {
      const local = checker.getSymbolAtLocation(name);
      if (local && target) {
        forwarded.set(local, target);
        if (targets(target).size) {
          names.add(name.text);
        }
      }
    };
    if (ts.isObjectBindingPattern(binding.name)) {
      if (
        binding.name.elements.some(
          (element) =>
            !ts.isBindingElement(element) ||
            !element.name ||
            !ts.isIdentifier(element.name) ||
            element.dotDotDotToken ||
            (element.propertyName && ts.isComputedPropertyName(element.propertyName)),
        )
      ) {
        continue;
      }
      for (const element of binding.name.elements) {
        if (!ts.isBindingElement(element) || !element.name || !ts.isIdentifier(element.name)) {
          continue;
        }
        const key =
          element.propertyName?.getText().replace(/^['"]|['"]$/g, "") ?? element.name.text;
        record(element.name, checker.getMemberInModuleExports(module, key));
      }
      handledImports.add(dynamicImport);
    } else if (ts.isIdentifier(binding.name)) {
      record(binding.name, module);
      handledImports.add(dynamicImport);
    }
  }
  const edges = new Map<BoundaryOperation, Set<BoundaryOperation>>();
  const accessSymbol = (expression: ts.Expression): Symbol | undefined => {
    const known = resolveSymbol(checker.getSymbolAtLocation(expression));
    if (known) {
      return known;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const base = accessSymbol(expression.expression);
      if (base && base.flags & SymbolFlags.Module) {
        return checker.getMemberInModuleExports(base, expression.name.text);
      }
    }
    return undefined;
  };
  for (const { file, source } of sources) {
    const references: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        return;
      }
      if (
        (((ts.isIdentifier(node) || ts.isStringLiteral(node)) && names.has(node.text)) ||
          (ts.isStringLiteral(node) &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
            !handledImports.has(node.parent))) &&
        !declarations.has(node.parent) &&
        !(ts.isBindingElement(node.parent) && node.parent.name === node) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      ) {
        references.push(node);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    const symbols = checker.getSymbolAtLocation(references);
    for (const [index, node] of references.entries()) {
      let symbol = resolveSymbol(
        ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : symbols[index],
      );
      if (!symbol && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        symbol = resolveSymbol(accessSymbol(node.parent));
      }
      if (!symbol && ts.isElementAccessExpression(node.parent) && ts.isStringLiteral(node)) {
        const base = accessSymbol(node.parent.expression);
        if (base && base.flags & SymbolFlags.Module) {
          symbol = resolveSymbol(checker.getMemberInModuleExports(base, node.text));
        }
      }
      const callees = targets(symbol);
      if (!callees.size) {
        continue;
      }
      // Namespace member access is inspected at its member. A computed/escaped
      // namespace cannot prove which member will be used, so it remains a caller.
      if (
        symbol &&
        symbol.flags & SymbolFlags.Module &&
        ((ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) ||
          (ts.isElementAccessExpression(node.parent) &&
            node.parent.expression === node &&
            ts.isStringLiteral(node.parent.argumentExpression)))
      ) {
        continue;
      }
      let owner: BoundaryOperation | undefined;
      let unprovenCallback = false;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        owner = declarations.get(parent);
        if (owner) {
          break;
        }
        if (
          ts.isMethodDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
            !isInlineInvocation(parent))
        ) {
          unprovenCallback = ts.isArrowFunction(parent) || ts.isFunctionExpression(parent);
          break;
        }
      }
      for (const callee of callees) {
        const expression =
          ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)
            ? node.parent
            : node;
        const directCall =
          ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
        if (owner && directCall) {
          const outgoing = edges.get(owner) ?? new Set<BoundaryOperation>();
          outgoing.add(callee);
          edges.set(owner, outgoing);
        } else {
          let nonRuntime = false;
          if ((!callee.reviewed || callee.candidate) && directCall && !unprovenCallback) {
            const enclosingNames: string[] = [];
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (
                (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
                parent.name &&
                ts.isIdentifier(parent.name)
              ) {
                enclosingNames.unshift(parent.name.text);
              }
            }
            const name = enclosingNames.join(".");
            const tier = classifyEntry(file, name);
            nonRuntime = tier !== undefined || isNonRuntime(file, name);
            if (tier) {
              callee.entries.add(tier);
            } else {
              callee.nonRuntimeValid = false;
            }
          } else {
            callee.nonRuntimeValid = false;
          }
          if (nonRuntime) {
            continue;
          }
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
          if (callee.reviewed && !callee.candidate) {
            violations.push(
              `${file}:${line + 1}:${character + 1}: bundled runtime reference to deprecated synchronous SQLite API ${callee.file}:${callee.name}`,
            );
          }
          callee.valid = false;
        }
      }
    }
  }
  const compatibilityReachable = new Set(
    [...registered.values()].filter((operation) => operation.reviewed && !operation.candidate),
  );
  for (const operation of compatibilityReachable) {
    for (const callee of edges.get(operation) ?? []) {
      compatibilityReachable.add(callee);
    }
  }
  // A public export can be called outside this source snapshot. Only reviewed
  // deprecated boundaries may rely on the separate compatibility contract.
  for (const { file, source } of sources) {
    if (
      !file.startsWith("src/plugin-sdk/") &&
      !/^extensions\/[^/]+\/(?:runtime-api|api)\.ts$/.test(file)
    ) {
      continue;
    }
    for (const operation of targets(checker.getSymbolAtLocation(source))) {
      if (!compatibilityReachable.has(operation)) {
        operation.nonRuntimeValid = false;
      }
    }
  }
  // A reachable wrapper also makes its callees live.
  changed = true;
  while (changed) {
    changed = false;
    for (const [caller, callees] of edges) {
      for (const callee of callees) {
        if (!caller.valid && callee.valid) {
          callee.valid = false;
          changed = true;
        }
        if (!caller.nonRuntimeValid && callee.nonRuntimeValid) {
          callee.nonRuntimeValid = false;
          changed = true;
        }
        for (const tier of caller.entries) {
          if (!callee.entries.has(tier)) {
            callee.entries.add(tier);
            changed = true;
          }
        }
      }
    }
  }
  for (const operation of registered.values()) {
    if (
      operation.reviewed &&
      !operation.candidate &&
      !operation.valid &&
      !violations.some((violation) => violation.includes(`${operation.file}:${operation.name}`))
    ) {
      violations.push(
        `${operation.file}:${operation.name}: reviewed compatibility operation is reachable through a live or escaped kernel`,
      );
    }
    const compatibility = compatibilityReachable.has(operation);
    if (
      operation.valid &&
      (compatibility || (operation.nonRuntimeValid && operation.entries.size))
    ) {
      const selectedLocations = compatibility ? callLocations : nonRuntimeCallLocations;
      if (compatibility) {
        const selected = operations.get(operation.file) ?? new Set<string>();
        selected.add(operation.name);
        operations.set(operation.file, selected);
      } else {
        const selected =
          nonRuntimeOperations.get(operation.file) ?? new Map<string, NonRuntimeTier>();
        const tier = operation.entries.has("T2") ? "T2" : operation.entries.has("T3") ? "T3" : "W";
        selected.set(operation.name, tier);
        nonRuntimeOperations.set(operation.file, selected);
      }
      const locations = selectedLocations.get(operation.file) ?? new Set<string>();
      const source = operation.node.getSourceFile();
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLikeDeclaration(node) && node !== operation.node) {
          // Only IIFEs and reviewed callback entries retain this execution scope.
          if (!isInlineInvocation(node)) {
            return;
          }
        }
        if (ts.isCallExpression(node)) {
          const { line, character } = source.getLineAndCharacterOfPosition(
            node.expression.getStart(),
          );
          locations.add(`${line + 1}:${character + 1}`);
        }
        node.forEachChild(visit);
      };
      visit(operation.node);
      selectedLocations.set(operation.file, locations);
    }
  }
  return {
    operations,
    callLocations,
    nonRuntimeOperations,
    nonRuntimeCallLocations,
    violations: [...new Set(violations)].toSorted(),
  };
}
