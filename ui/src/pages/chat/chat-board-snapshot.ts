import type { BoardSnapshot } from "@openclaw/gateway-protocol";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";

type ChatMessageCacheHost = Parameters<typeof cacheChatSessionSnapshot>[1];
type ChatMessageCacheTarget = Parameters<typeof cacheChatSessionSnapshot>[2];

export function cacheChatBoardSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  snapshot: BoardSnapshot | null,
  receivedAtMs = Date.now(),
): void {
  const existing = readChatSessionSnapshot(cache, host, target);
  if (snapshot ? existing?.board?.snapshot === snapshot : existing?.board === null) {
    return;
  }
  cacheChatSessionSnapshot(cache, host, target, {
    ...(existing ?? { messages: [], pagination: { hasMore: false }, sessionId: null }),
    board: snapshot ? { snapshot, receivedAtMs } : null,
  });
}

export function mergeStoredChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  stored: ChatSessionSnapshot | null,
): ChatSessionSnapshot | null {
  const cached = readChatSessionSnapshot(cache, host, target);
  const board = cached?.board === undefined ? stored?.board : cached.board;
  // A board can arrive before history; its empty envelope must not hide stored rows.
  const snapshot =
    stored && cached?.sessionId === null && cached.messages.length === 0
      ? stored
      : (cached ?? stored);
  if (board) {
    cacheChatBoardSnapshot(cache, host, target, board.snapshot, board.receivedAtMs);
  }
  return snapshot && board !== undefined ? { ...snapshot, board } : snapshot;
}
