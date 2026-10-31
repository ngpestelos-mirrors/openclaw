import { Virtualizer } from "@tanstack/virtual-core";
import { vi } from "vitest";
import {
  cacheChatSessionSnapshot,
  createChatWidgetLayout,
  type ChatMessageCache,
} from "../session-message-cache.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { threadProps } from "./chat-transcript.test-support.ts";

export function scheduledCallbacks(idle: boolean) {
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const idleCallbacks = new Map<number, IdleRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "requestIdleCallback",
    idle
      ? (callback: IdleRequestCallback) => {
          idleCallbacks.set(++sequence, callback);
          return sequence;
        }
      : undefined,
  );
  vi.stubGlobal("cancelIdleCallback", (id: number) => idleCallbacks.delete(id));
  const takeFrame = () => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    return () => callback(0);
  };
  const takeIdle = () => {
    const [id, callback] = idleCallbacks.entries().next().value!;
    idleCallbacks.delete(id);
    return () => callback({ didTimeout: false, timeRemaining: () => 50 });
  };
  return { frames, idleCallbacks, takeFrame, takeIdle };
}

/** Seed geometry through its real writer, then return a fresh reservation. */
export function admitFootprint(
  source: TranscriptLayoutOwner,
  props: ChatThreadProps,
  height: number,
  avatarPlacement = "gutter",
) {
  const cache: ChatMessageCache = new Map();
  const host = { assistantAgentId: "main" };
  const target = { sessionKey: props.sessionKey ?? "agent:main:layout-footprint" };
  cacheChatSessionSnapshot(cache, host, target, {
    messages: [],
    pagination: { hasMore: false },
    sessionId: "one",
  });
  const layout = new TranscriptLayoutOwner(() => {});
  layout.configureRows(
    { ...props, widgetLayout: createChatWidgetLayout()(cache, host, target) },
    avatarPlacement,
    false,
  );
  layout.rows = source.rows;
  layout.rowWidth = source.rowWidth;
  layout.paneWidth = source.paneWidth;
  layout.rowGutter = source.rowGutter;
  const descriptors = [
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "requestIdleCallback",
    "cancelIdleCallback",
  ].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const scheduled = scheduledCallbacks(false);
  try {
    const mounted = mountedVirtualizer(layout, height);
    try {
      layout.persistRows(mounted.instance, false);
      scheduled.takeFrame()();
      scheduled.takeFrame()();
    } finally {
      layout.disconnect();
      mounted.dispose();
    }
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  }
  return createChatWidgetLayout()(cache, host, target);
}

export function footprintLayout() {
  const layout = new TranscriptLayoutOwner(() => {});
  const props = threadProps("layout-lifetime", undefined, []);
  layout.configureRows(props, "gutter", false);
  layout.rowWidth = 768;
  layout.paneWidth = 1100;
  layout.rows = [{ key: "row", revision: "revision" }];
  const rowLayout = admitFootprint(layout, props, 300);
  layout.rowLayout = rowLayout;
  const writeRows = vi.spyOn(rowLayout, "writeRows");
  return { layout, writeRows };
}

export function mountedVirtualizer(layout: TranscriptLayoutOwner, height = 100) {
  const viewport = document.body.appendChild(document.createElement("div"));
  const row = viewport.appendChild(document.createElement("div"));
  row.dataset.index = "0";
  layout.connect(viewport);
  const instance = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 1,
    getItemKey: () => "row",
    estimateSize: () => height,
    getScrollElement: () => viewport,
    observeElementRect: (_, callback) => {
      callback({ width: 768, height: 600 });
    },
    observeElementOffset: (_, callback) => {
      callback(0, false);
    },
    scrollToFn: () => {},
  });
  const { _didMount: mount, _willUpdate: update } = instance;
  const dispose = mount();
  update();
  instance.measureElement(row);
  instance.resizeItem(0, height);
  return {
    instance,
    dispose: () => {
      dispose();
      viewport.remove();
    },
  };
}

export const phases = [
  { label: "animation frame", idle: true, advance: false },
  { label: "idle callback", idle: true, advance: true },
  { label: "fallback animation frame", idle: false, advance: true },
];
