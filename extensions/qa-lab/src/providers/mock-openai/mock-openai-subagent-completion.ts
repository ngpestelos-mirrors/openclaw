import {
  subagentFanoutTaskForProvider,
  type MockScenarioState,
  type ResponsesInputItem,
} from "./mock-openai-contracts.js";
import {
  extractAllRequestTexts,
  extractLastUserText,
  extractLastMatchingUserTurn,
  parseToolOutputJson,
  resolveMockSubagentTurn,
  splitMockConversationContext,
} from "./mock-openai-input.js";

function normalizeChildResult(result: string) {
  return result === "Child result: (no output)" || result === "(no output)" ? "" : result;
}

export function readMockSubagentCompletion(
  input: ResponsesInputItem[],
  label: "qa-sidecar" | "qa-fork-context",
) {
  const currentTurn = extractLastMatchingUserTurn(input);
  const { current } = splitMockConversationContext(currentTurn?.text ?? "");
  const currentInput = [
    current,
    extractAllRequestTexts(input.slice(currentTurn ? currentTurn.index + 1 : input.length), {}),
  ].join("\n");
  const settled = new RegExp(
    `(?:^|\\n)\\d+\\. Child task[^\\n]*\\n<prompt-data>\\n${label}\\n<\\/prompt-data>\\nstatus: ([^\\n]+)\\nChild result[^\\n]*\\n<prompt-data>\\n([\\s\\S]*?)\\n<\\/prompt-data>`,
  ).exec(current);
  if (
    settled &&
    current.includes(
      "[Subagent Context] Every subagent spawned from this session has now settled",
    ) &&
    currentInput.includes("sourceTool=subagent_settle")
  ) {
    return { ok: settled[1] === "ok", result: normalizeChildResult(settled[2] ?? "") };
  }
  // The current protected event owns completion; earlier quoted results cannot
  // complete a new user turn. The input owner also decodes v4 runtime carriers.
  const turn = resolveMockSubagentTurn(input);
  if (
    turn?.kind !== "completion" ||
    !turn.text.includes(`\ntask: ${label}\n`) ||
    !/^source: subagent$/m.test(turn.text)
  ) {
    return undefined;
  }
  const match = /\nstatus: ([^\n]+)\n\n([\s\S]*?)(?:\n\n(?:Stats:|Action:)|$)/.exec(turn.text);
  if (!match) {
    return { ok: false, result: "Malformed child completion" };
  }
  const body = match[2] ?? "";
  // Protected v3 events wrap child data; v4 carriers quote the raw data variant.
  const result =
    /^Child result[^\n]*\n<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/.exec(body)?.[1] ?? body;
  return {
    ok: match[1] === "completed; ready for parent review",
    result: normalizeChildResult(result),
  };
}

export function readMockSubagentSpawnFailure(toolOutput: string): string | undefined {
  const result = parseToolOutputJson(toolOutput);
  if (
    result?.status === "accepted" &&
    typeof result.childSessionKey === "string" &&
    result.childSessionKey.trim()
  ) {
    return undefined;
  }
  const reason =
    typeof result?.error === "string"
      ? result.error
      : result?.status === "error" || result?.status === "forbidden"
        ? "spawn failed"
        : "spawn was not accepted with a child session key";
  return `Failed to delegate: ${reason}`;
}

type MockSubagentPlan =
  | { text: string }
  | { tool: "sessions_spawn" | "sessions_yield"; args: Record<string, unknown> };

export function resolveMockSubagentHandoff(params: {
  input: ResponsesInputItem[];
  body: Record<string, unknown>;
  state: MockScenarioState;
  toolOutput: string;
  canSpawn: boolean;
  canYield: boolean;
  task: string;
}): MockSubagentPlan | undefined {
  const { input, toolOutput } = params;
  const completion = readMockSubagentCompletion(input, "qa-sidecar");
  if (completion) {
    const result = completion.result.trim();
    const detail =
      completion.ok && result
        ? result
        : `Subagent unavailable: ${result || "missing child result"}`;
    return {
      text: `Delegated task:\n- Inspect the QA workspace via a bounded subagent.\nResult:\n- ${detail}\nEvidence:\n- The completed child result was returned to the requester.`,
    };
  }
  const { current } = splitMockConversationContext(extractLastUserText(input));
  const handoff = /delegate (?:one |a )bounded qa task|subagent handoff/i;
  const allText = extractAllRequestTexts(input, params.body);
  if (
    !handoff.test(current) &&
    !(/^(?:continue|continue again)[.!]?$/i.test(current) && handoff.test(allText))
  ) {
    return undefined;
  }
  if (!toolOutput && !params.state.subagentHandoffSpawned && params.canSpawn) {
    params.state.subagentHandoffSpawned = true;
    return {
      tool: "sessions_spawn",
      args: {
        task: params.task,
        label: "qa-sidecar",
        ...(!/nested worker lineage handoff/i.test(allText) ? { thread: false } : {}),
      },
    };
  }
  const spawnFailure = readMockSubagentSpawnFailure(toolOutput);
  if (spawnFailure) {
    return { text: spawnFailure };
  }
  // A spawn receipt acknowledges admission, not completion. Yield until the
  // owner delivers the protected child result or the all-settled wake.
  return params.canYield
    ? {
        tool: "sessions_yield",
        args: { message: "Waiting for the bounded QA subagent to finish." },
      }
    : { text: "Waiting for the bounded QA subagent to finish." };
}

export function resolveMockSubagentFanoutAdmission(params: {
  state: MockScenarioState;
  toolOutput: string;
  hasCompletedToolOutput: boolean;
  completedSpawn: boolean;
  canSpawn: boolean;
  providerVariant: Parameters<typeof subagentFanoutTaskForProvider>[0];
}): MockSubagentPlan | undefined {
  const { state, hasCompletedToolOutput } = params;
  if (
    hasCompletedToolOutput &&
    (state.subagentFanoutPhase === 1 || (state.subagentFanoutPhase === 2 && params.completedSpawn))
  ) {
    const failure = readMockSubagentSpawnFailure(params.toolOutput);
    if (failure) {
      return { text: failure };
    }
  }
  if (!params.canSpawn) {
    return undefined;
  }
  const worker =
    !hasCompletedToolOutput && state.subagentFanoutPhase === 0
      ? "alpha"
      : hasCompletedToolOutput && state.subagentFanoutPhase === 1
        ? "beta"
        : undefined;
  if (!worker) {
    return undefined;
  }
  state.subagentFanoutPhase = worker === "alpha" ? 1 : 2;
  return {
    tool: "sessions_spawn",
    args: {
      task: subagentFanoutTaskForProvider(params.providerVariant, worker),
      label: `qa-fanout-${worker}`,
      thread: false,
    },
  };
}

type TerminalRequesterSettleGate = {
  markSettled: (caseName: string, childSessionKey: string) => void;
  waitUntilSettled: (caseName: string, childSessionKey: string) => Promise<void>;
};

export function createTerminalRequesterSettleGate(): TerminalRequesterSettleGate {
  const settledChildren = new Set<string>();
  const waiterPromises = new Map<string, Promise<void>>();
  const waiters = new Map<string, () => void>();
  const childKey = (caseName: string, childSessionKey: string) => `${caseName}\n${childSessionKey}`;
  return {
    markSettled(caseName, childSessionKey) {
      const key = childKey(caseName, childSessionKey);
      settledChildren.add(key);
      waiters.get(key)?.();
    },
    async waitUntilSettled(caseName, childSessionKey) {
      const key = childKey(caseName, childSessionKey);
      if (settledChildren.has(key)) {
        return;
      }
      const existing = waiterPromises.get(key);
      if (existing) {
        return await existing;
      }
      const promise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(key);
          waiterPromises.delete(key);
          reject(new Error(`terminal requester did not settle: ${caseName} (${childSessionKey})`));
        }, 30_000);
        const finish = () => {
          clearTimeout(timeout);
          waiters.delete(key);
          waiterPromises.delete(key);
          resolve();
        };
        waiters.set(key, finish);
      });
      waiterPromises.set(key, promise);
      await promise;
    },
  };
}
