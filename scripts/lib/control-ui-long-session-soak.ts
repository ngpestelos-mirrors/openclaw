import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { createControlUiTeamScaleFixture } from "../../ui/src/test-helpers/control-ui-team-scale-fixture.ts";

export function longSessionInitScript() {
  return `;(() => { if (window !== window.top) return; const __name = (f) => f; (${installLongSessionProbe.toString()})(); })();`;
}

// Weak references let Chromium collect disconnected application objects during the soak.
function installLongSessionProbe() {
  const sets: WeakRef<Set<unknown>>[] = [];
  const NativeSet = window.Set;
  window.Set = class<T> extends NativeSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      sets.push(new WeakRef(this));
    }
  };
  const observers: Array<{ ref: WeakRef<object>; kind: string; targets: WeakRef<Node>[] }> = [];
  for (const kind of ["MutationObserver", "ResizeObserver"] as const) {
    const Native = window[kind];
    const records = new WeakMap<object, (typeof observers)[number]>();
    const prototype = Native.prototype;
    const observe = prototype.observe;
    const disconnect = prototype.disconnect;
    Object.defineProperty(prototype, "observe", {
      value(this: object, target: Node, options: unknown) {
        const result = Reflect.apply(observe, this, [target, options]);
        let record = records.get(this);
        if (!record) {
          record = { ref: new WeakRef(this), kind, targets: [] };
          records.set(this, record);
          observers.push(record);
        }
        if (!record.targets.some((ref) => ref.deref() === target)) {
          record.targets.push(new WeakRef(target));
        }
        return result;
      },
    });
    Object.defineProperty(prototype, "disconnect", {
      value(this: object) {
        const result = Reflect.apply(disconnect, this, []);
        const record = records.get(this);
        if (record) record.targets.length = 0;
        return result;
      },
    });
    if (kind === "ResizeObserver") {
      const unobserve = ResizeObserver.prototype.unobserve;
      ResizeObserver.prototype.unobserve = function (target) {
        const record = records.get(this);
        if (record) record.targets = record.targets.filter((ref) => ref.deref() !== target);
        return unobserve.call(this, target);
      };
    }
  }
  const timeouts = new Map<number, string>();
  const intervals = new Map<number, string>();
  const stack = () => new Error().stack?.split("\n").slice(2, 6).join(" <- ") ?? "";
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeInterval = window.setInterval.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = nativeTimeout(() => {
      timeouts.delete(id);
      if (typeof handler === "function") handler(...args);
      else throw new Error("String timers are unsupported in this experiment");
    }, delay);
    timeouts.set(id, stack());
    return id;
  };
  window.setInterval = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = nativeInterval(handler, delay, ...args);
    intervals.set(id, stack());
    return id;
  };
  window.clearTimeout = (id?: number) => {
    if (id !== undefined) {
      timeouts.delete(id);
      intervals.delete(id);
    }
    nativeClearTimeout(id);
  };
  window.clearInterval = (id?: number) => {
    if (id !== undefined) {
      timeouts.delete(id);
      intervals.delete(id);
    }
    nativeClearInterval(id);
  };
  let emitted = 0;
  const kinds: Record<string, number> = {};
  let dispatchMs = 0;
  const subscriptions = new NativeSet<string>();
  const originalSocket = window.WebSocket;
  window.WebSocket = new Proxy(originalSocket, {
    construct(target, args) {
      const socket: WebSocket = Reflect.construct(target, args);
      const dispatch = socket.dispatchEvent;
      socket.dispatchEvent = function (event) {
        const started = performance.now();
        try {
          return dispatch.call(this, event);
        } finally {
          dispatchMs += performance.now() - started;
        }
      };
      const send = socket.send;
      socket.send = function (data) {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.method === "sessions.messages.subscribe") subscriptions.add(frame.params.key);
          if (frame.method === "sessions.messages.unsubscribe")
            subscriptions.delete(frame.params.key);
        }
        return send.call(this, data);
      };
      return socket;
    },
  });
  Reflect.set(window, "__longSession", {
    emitted(event: string) {
      emitted++;
      kinds[event] = (kinds[event] ?? 0) + 1;
    },
    drain() {
      const callbackSets = { sets: 0, callbacks: 0 };
      for (let i = sets.length - 1; i >= 0; i--) {
        const set = sets[i]!.deref();
        if (!set) {
          sets.splice(i, 1);
          continue;
        }
        const callbacks = [...set].filter((item) => typeof item === "function").length;
        if (callbacks) {
          callbackSets.sets++;
          callbackSets.callbacks += callbacks;
        }
      }
      const activeObservers: Record<
        string,
        { observers: number; targets: number; detached: number }
      > = {};
      for (let i = observers.length - 1; i >= 0; i--) {
        const record = observers[i]!;
        if (!record.ref.deref()) {
          observers.splice(i, 1);
          continue;
        }
        record.targets = record.targets.filter((ref) => ref.deref());
        if (!record.targets.length) continue;
        const group = (activeObservers[record.kind] ??= { observers: 0, targets: 0, detached: 0 });
        group.observers++;
        group.targets += record.targets.length;
        group.detached += record.targets.filter((ref) => !ref.deref()?.isConnected).length;
      }
      const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
      const requests = gateway.requests.splice(0);
      const rpcCounts: Record<string, number> = {};
      for (const request of requests)
        rpcCounts[request.method] = (rpcCounts[request.method] ?? 0) + 1;
      const cold = Reflect.get(window, "__coldLoad").read();
      cold.rpcs.length = 0;
      cold.longTasks.length = 0;
      performance.clearMarks();
      performance.clearMeasures();
      const perf = Reflect.get(window, "__perf");
      const loaf = perf?.loaf.splice(0) ?? [];
      const mutations = perf ? [...perf.mut] : [];
      perf?.mut.clear();
      Reflect.get(window, "__mutAttr")?.clear();
      Reflect.get(window, "__wsLog")?.splice(0);
      const result = {
        atMs: performance.now(),
        route: location.pathname,
        emitted,
        kinds: { ...kinds },
        dispatchMs,
        callbackSets,
        activeObservers,
        timeouts: timeouts.size,
        intervals: intervals.size,
        protocolSubscriptions: [...subscriptions],
        rpcCounts,
        loaf,
        mutations,
        elements: document.querySelectorAll("*").length,
        panes: document.querySelectorAll(".chat-pane-cache__pane").length,
        timerStacks: [...timeouts.values(), ...intervals.values()],
      };
      emitted = 0;
      dispatchMs = 0;
      for (const key of Object.keys(kinds)) delete kinds[key];
      return result;
    },
  });
}

export async function runLongSessionSoak(input: {
  page: Page;
  context: BrowserContext;
  fixture: ReturnType<typeof createControlUiTeamScaleFixture>;
  minutes: number;
  artifactDir: string;
}) {
  const { page, context, fixture, minutes, artifactDir } = input;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  const samples: unknown[] = [];
  const start = Date.now();
  await page.evaluate(
    ({ events, history, selectedKey }) => {
      const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
      const probe = Reflect.get(window, "__longSession");
      let index = 0;
      let cycle = 0;
      let seq = 0;
      let text = "";
      const messages = history.messages;
      const emit = (event: string, payload: unknown) => {
        probe.emitted(event);
        gateway.emit(event, payload);
      };
      const runId = () => `long-session-run-${cycle}`;
      for (const method of ["chat.history", "chat.startup"]) {
        gateway.setRequestHandler(method, ({ params, respond }) => {
          const key = params.sessionKey ?? selectedKey;
          const row = gateway.getSessionRow(key);
          respond({
            sessionId: row.sessionId,
            sessionInfo: row,
            messages,
            ...(key === selectedKey
              ? { inFlightRun: { runId: runId(), text, startedAt: Date.now(), events: [] } }
              : {}),
            ...(method === "chat.startup" ? { metadata: { models: [] } } : {}),
          });
        });
      }
      const timer = setInterval(() => {
        const template = events[index]!;
        const ts = Date.now();
        const payload = JSON.parse(JSON.stringify(template.payload), (key, value) => {
          if (key === "ts" || key === "snapshotAt") return ts;
          if (key === "runId" || key === "clientRunId") return runId();
          if (key === "activeRunIds") return [runId()];
          return value;
        });
        if (template.event === "session.message") {
          payload.messageId = `long-session-message-${cycle}-${index}`;
          payload.messageSeq = messages.length + 1;
          payload.message.__openclaw.id = payload.messageId;
          payload.message.timestamp = ts;
          messages.push(payload.message);
        }
        if (template.event === "chat") {
          text += `Synthetic progress ${index}. `;
          payload.message.content[0].text = text;
          payload.seq = ++seq;
        }
        emit(template.event, payload);
        if (index === 0) {
          emit("agent", {
            sessionKey: selectedKey,
            runId: runId(),
            seq: ++seq,
            ts,
            stream: "lifecycle",
            data: { phase: "start", startedAt: ts },
          });
          emit("session.tool", {
            sessionKey: selectedKey,
            agentId: "main",
            runId: runId(),
            seq: ++seq,
            ts,
            stream: "tool",
            data: {
              phase: "start",
              toolCallId: `soak-tool-${cycle}`,
              name: "read",
              args: { path: "synthetic.txt" },
            },
          });
        }
        if (index === 2)
          emit("session.tool", {
            sessionKey: selectedKey,
            agentId: "main",
            runId: runId(),
            seq: ++seq,
            ts,
            stream: "tool",
            data: {
              phase: "result",
              toolCallId: `soak-tool-${cycle}`,
              name: "read",
              result: "Synthetic result.",
            },
          });
        index++;
        if (index === events.length) {
          const message = {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: ts,
            __openclaw: { id: `long-session-final-${cycle}` },
          };
          messages.push(message);
          emit("chat", {
            sessionKey: selectedKey,
            runId: runId(),
            seq: ++seq,
            state: "final",
            message,
          });
          emit("agent", {
            sessionKey: selectedKey,
            runId: runId(),
            seq: ++seq,
            ts,
            stream: "lifecycle",
            data: { phase: "end", endedAt: ts },
          });
          cycle++;
          index = 0;
          seq = 0;
          text = "";
        }
      }, 160);
      Reflect.set(window, "__stopLongSession", () => clearInterval(timer));
    },
    {
      events: fixture.liveEvents,
      history: fixture.liveHistory!,
      selectedKey: fixture.selectedSessionKey,
    },
  );
  for (let minute = 0; minute <= minutes; minute++) {
    const delay = start + minute * 60_000 - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    // Drain measurements before collecting so the probes' per-minute histories are not retained.
    const probe = await page.evaluate(() => Reflect.get(window, "__longSession").drain());
    await cdp.send("HeapProfiler.collectGarbage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const performance = await cdp.send("Performance.getMetrics");
    const sample = {
      minute,
      elapsedMs: Date.now() - start,
      probe,
      dom,
      heap,
      performance: Object.fromEntries(
        performance.metrics.map((entry) => [entry.name, entry.value]),
      ),
    };
    samples.push(sample);
    await appendFile(path.join(artifactDir, "soak.jsonl"), JSON.stringify(sample) + "\n");
    console.log(
      "SOAK " +
        JSON.stringify({
          minute,
          heap: heap.usedSize,
          ...dom,
          events: probe.emitted,
          callbacks: probe.callbackSets,
          observers: probe.activeObservers,
          timeouts: probe.timeouts,
          intervals: probe.intervals,
        }),
    );
    if (minute && minute < minutes && minute % 2 === 0) {
      const key = fixture.pinnedKeys[(minute / 2) % 3]!;
      await page.locator(`[data-sidebar-entry="session:${key}"]`).click();
      await page.waitForFunction((expected) => location.pathname !== expected, probe.route);
      await page.locator(".chat-pane-cache__pane--active").waitFor();
    }
  }
  await page.evaluate(() => Reflect.get(window, "__stopLongSession")());
  await writeFile(path.join(artifactDir, "soak.json"), JSON.stringify(samples, null, 2));
  await cdp.detach();
}
