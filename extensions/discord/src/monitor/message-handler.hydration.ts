import { MessageReferenceType, MessageType, type APIMessage } from "discord-api-types/v10";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { readStringValue as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getChannelMessage, Message as DiscordMessage, type Message } from "../internal/discord.js";
import { resolveDiscordMessageStickers } from "./message-forwarded.js";
import { resolveDiscordMessageText } from "./message-text.js";

function mergeFetchedDiscordMessage(base: Message, fetched: APIMessage): Message {
  // Message getters project rawData; partial messages retain only their IDs.
  const baseRawData = readMessageRawData(base);
  const rawData = {
    ...baseRawData,
    ...fetched,
    id: fetched.id ?? baseRawData.id ?? (typeof base.id === "string" ? base.id : ""),
    channel_id: fetched.channel_id ?? baseRawData.channel_id ?? readString(base.channel_id) ?? "",
    content: fetched.content ?? baseRawData.content ?? "",
    author: fetched.author ??
      baseRawData.author ?? {
        id: "",
        username: "",
        discriminator: "0",
        global_name: null,
        avatar: null,
      },
    attachments: fetched.attachments ?? baseRawData.attachments ?? [],
    embeds: fetched.embeds ?? baseRawData.embeds ?? [],
    mentions: fetched.mentions ?? baseRawData.mentions ?? [],
    mention_roles: fetched.mention_roles ?? baseRawData.mention_roles ?? [],
    mention_everyone: fetched.mention_everyone ?? baseRawData.mention_everyone ?? false,
    timestamp: fetched.timestamp ?? baseRawData.timestamp ?? "1970-01-01T00:00:00.000Z",
    tts: fetched.tts ?? baseRawData.tts ?? false,
    pinned: fetched.pinned ?? baseRawData.pinned ?? false,
    type: fetched.type ?? baseRawData.type ?? 0,
    message_snapshots: fetched.message_snapshots ?? baseRawData.message_snapshots,
    sticker_items: fetched.sticker_items ?? baseRawData.sticker_items ?? [],
  } as APIMessage;
  const hydrated = new DiscordMessage(readMessageClient(base), rawData);
  const channelDescriptor = Object.getOwnPropertyDescriptor(base, "channel");
  if (channelDescriptor) {
    Object.defineProperty(hydrated, "channel", channelDescriptor);
  }
  return hydrated;
}

function readMessageClient(message: Message): ConstructorParameters<typeof DiscordMessage>[0] {
  return (message as unknown as { client: ConstructorParameters<typeof DiscordMessage>[0] }).client;
}

function readMessageRawData(message: Message): Partial<APIMessage> {
  try {
    const rawData = message.rawData as APIMessage | undefined;
    return rawData && typeof rawData === "object" ? rawData : {};
  } catch {
    return {};
  }
}

function shouldHydrateDiscordMessagePayload(params: { message: Message }) {
  let currentText;
  try {
    currentText = resolveDiscordMessageText(params.message, {
      includeForwarded: true,
    });
  } catch {
    return true;
  }
  if (!currentText) {
    return true;
  }
  const hasMentionMetadata =
    (params.message.mentionedUsers?.length ?? 0) > 0 ||
    (params.message.mentionedRoles?.length ?? 0) > 0 ||
    params.message.mentionedEveryone;
  if (hasMentionMetadata) {
    return false;
  }
  return /<@!?\d+>|<@&\d+>|@everyone|@here/u.test(currentText);
}

type ReferencedMessagePayloadState = "complete" | "missing" | "invalid";

function resolveReferencedMessagePayloadState(message: Message): ReferencedMessagePayloadState {
  const reference = message.messageReference;
  if (!reference?.message_id) {
    return "complete";
  }
  if (reference.type != null && reference.type !== MessageReferenceType.Default) {
    return "complete";
  }
  if (message.type != null && message.type !== MessageType.Reply) {
    return "complete";
  }
  const rawData = readMessageRawData(message);
  if (!Object.hasOwn(rawData, "referenced_message")) {
    return "missing";
  }
  const referenced = rawData.referenced_message;
  if (referenced == null) {
    return "complete";
  }
  if (typeof referenced !== "object" || referenced.id !== reference.message_id) {
    return "invalid";
  }
  const reply = message.referencedMessage;
  // A matching ID can still carry an empty nested payload; recover the selected
  // message before treating that absence as the user's intended reply context.
  return reply?.author &&
    (resolveDiscordMessageText(reply, { includeForwarded: true }) ||
      reply.attachments.length > 0 ||
      resolveDiscordMessageStickers(reply).length > 0)
    ? "complete"
    : "missing";
}

async function hydrateDiscordReplyReference(params: {
  client: { rest: Parameters<typeof getChannelMessage>[0] };
  message: Message;
  messageChannelId: string;
}): Promise<Message> {
  const payloadState = resolveReferencedMessagePayloadState(params.message);
  if (payloadState === "complete") {
    return params.message;
  }
  const reference = params.message.messageReference;
  const referencedMessageId = reference?.message_id;
  if (!referencedMessageId) {
    return params.message;
  }
  const referencedChannelId = reference.channel_id ?? params.messageChannelId;
  try {
    const referenced = await getChannelMessage(
      params.client.rest,
      referencedChannelId,
      referencedMessageId,
    );
    // Discord may omit referenced_message from both Gateway and REST reply payloads.
    // Attach the canonical referenced fetch so downstream reply context stays bounded.
    return mergeFetchedDiscordMessage(params.message, {
      ...readMessageRawData(params.message),
      referenced_message: referenced,
    } as APIMessage);
  } catch (err) {
    logVerbose(
      `discord: failed to hydrate referenced message ${referencedMessageId}: ${String(err)}`,
    );
    if (payloadState === "invalid") {
      // A mismatched nested payload must never become reply context for another message.
      return mergeFetchedDiscordMessage(params.message, {
        ...readMessageRawData(params.message),
        referenced_message: null,
      } as APIMessage);
    }
    return params.message;
  }
}

type DiscordMessageHydrationOutcome =
  | { kind: "authoritative"; message: Message }
  | { kind: "unavailable"; message: Message };

export async function hydrateDiscordMessageIfNeeded(params: {
  client: { rest: Parameters<typeof getChannelMessage>[0] };
  message: Message;
  messageChannelId: string;
}): Promise<DiscordMessageHydrationOutcome> {
  let hydrated = params.message;
  if (shouldHydrateDiscordMessagePayload({ message: params.message })) {
    try {
      const fetched = await getChannelMessage(
        params.client.rest,
        params.messageChannelId,
        params.message.id,
      );
      logVerbose(`discord: hydrated inbound payload via REST for ${params.message.id}`);
      hydrated = mergeFetchedDiscordMessage(params.message, fetched);
    } catch (err) {
      logVerbose(`discord: failed to hydrate message ${params.message.id}: ${String(err)}`);
      return { kind: "unavailable", message: params.message };
    }
  }
  return {
    kind: "authoritative",
    message: await hydrateDiscordReplyReference({
      client: params.client,
      message: hydrated,
      messageChannelId: params.messageChannelId,
    }),
  };
}
