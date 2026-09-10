import type { Message } from "grammy/types";
import {
  formatLocationText,
  formatMediaPlaceholderText,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  recordConversationObservation,
  type ConversationHistoryCapture,
} from "openclaw/plugin-sdk/reply-history";
import { buildConversationIdentity } from "openclaw/plugin-sdk/session-store-runtime";
import type { TelegramMediaRef } from "./bot-message-context.types.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessagePlaceholder,
  resolveTelegramRichMessageText,
} from "./bot/body-helpers.js";
import { buildTelegramInboundOriginTarget, type TelegramThreadSpec } from "./bot/helpers.js";
import { renderTelegramTextEntities } from "./bot/inbound-text-entities.js";
import { buildTelegramConversationId } from "./topic-conversation.js";

/** Existing buffers assemble source requests without changing their intake sequence. */
export function mergeTelegramConversationCaptures(
  captures: readonly (ConversationHistoryCapture | undefined)[],
): ConversationHistoryCapture | undefined {
  let merged: ConversationHistoryCapture | undefined;
  for (const capture of captures) {
    if (!capture) {
      continue;
    }
    if (
      merged &&
      (merged.conversationRef !== capture.conversationRef ||
        merged.owner.agentId !== capture.owner.agentId ||
        merged.owner.databasePath !== capture.owner.databasePath)
    ) {
      throw new Error("Telegram cannot combine inputs from different conversations");
    }
    merged = merged
      ? {
          ...merged,
          throughSequence: Math.max(merged.throughSequence, capture.throughSequence),
          requestSourceIds: [...merged.requestSourceIds, ...capture.requestSourceIds],
        }
      : capture;
  }
  return merged;
}

/** Normalize Telegram source events once before core assigns their durable sequence. */
export async function recordTelegramConversationMessages(params: {
  agentId: string;
  storePath: string;
  accountId: string;
  chatId: string | number;
  threadSpec: TelegramThreadSpec;
  messages: readonly Message[];
  media?: readonly TelegramMediaRef[];
  updateIds?: readonly (number | undefined)[];
  interactionId?: string;
}): Promise<ConversationHistoryCapture> {
  const identity = buildConversationIdentity({
    channel: "telegram",
    accountId: params.accountId,
    kind: "group",
    peerId: buildTelegramConversationId({ chatId: params.chatId, thread: params.threadSpec }),
    deliveryTarget: buildTelegramInboundOriginTarget(params.chatId, params.threadSpec),
    threadId: params.threadSpec.id,
  });
  if (!identity) {
    throw new Error("Telegram group observation requires a conversation identity");
  }
  const requestSourceIds: string[] = [];
  let capture: ConversationHistoryCapture | undefined;
  for (const [index, message] of params.messages.entries()) {
    const parts = getTelegramTextParts(message);
    const media =
      params.media?.filter((item) =>
        item.sourceMessageId
          ? item.sourceMessageId === String(message.message_id)
          : params.messages.length === 1,
      ) ?? [];
    const nativeMedia = resolveTelegramPrimaryMedia(message);
    const location = extractTelegramLocation(message);
    const text =
      [
        renderTelegramTextEntities(parts.text, parts.entities),
        location ? formatLocationText(location) : undefined,
      ]
        .filter(Boolean)
        .join("\n") ||
      resolveTelegramRichMessageText(message) ||
      resolveTelegramRichMessagePlaceholder(message) ||
      formatMediaPlaceholderText(nativeMedia ? [{ kind: nativeMedia.kind }] : []);
    const editUpdateId = message.edit_date ? params.updateIds?.[index] : undefined;
    if (message.edit_date && editUpdateId === undefined) {
      throw new Error("Telegram edited-message observation requires its native update identity");
    }
    const sourceId = params.interactionId
      ? `interaction:${params.interactionId}`
      : editUpdateId !== undefined
        ? `edit:${editUpdateId}`
        : String(message.message_id);
    requestSourceIds.push(sourceId);
    capture = await recordConversationObservation(
      { agentId: params.agentId, storePath: params.storePath },
      {
        conversationRef: identity.conversationRef,
        sourceId,
        message: {
          text: message.edit_date
            ? `[Edited Telegram message ${message.message_id}]\n${text}`
            : text,
          timestamp: message.date * 1000,
          sender: {
            id: message.from?.id?.toString(),
            name: buildSenderName(message),
            username: message.from?.username,
          },
          media: media.map(({ path, kind, contentType, fileName }) => ({
            path,
            kind,
            contentType,
            fileName,
            messageId: String(message.message_id),
          })),
          transport: {
            channel: "telegram",
            conversationRef: identity.conversationRef,
            messageId: String(message.message_id),
            replyToId: message.reply_to_message?.message_id.toString(),
            threadId: params.threadSpec.id?.toString(),
          },
        },
      },
    );
  }
  if (!capture) {
    throw new Error("Telegram observation requires a received message");
  }
  return { ...capture, requestSourceIds };
}
