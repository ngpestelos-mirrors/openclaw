// Prototype: a Discord-owned return link using the native session-header accessory API.
import { defineControlUiPlugin, type ControlUiAccessory } from "openclaw/plugin-sdk/control-ui";
import { z } from "zod";
import "./prototype.css";

// These existing Gateway projection fields are not yet named in SessionRow's SDK type.
const sessionSchema = z.object({
  key: z.string(),
  agentId: z.string().optional(),
  space: z.string().optional(),
  parentSessionKey: z.string().optional(),
  spawnedBy: z.string().optional(),
  origin: z
    .object({
      provider: z.string().optional(),
      chatType: z.string().optional(),
      nativeChannelId: z.string().optional(),
      to: z.string().optional(),
      threadId: z.string().optional(),
    })
    .optional(),
});

const snowflake = /^\d{17,20}$/u;

const mount: ControlUiAccessory["mount"] = (container, initialContext) => {
  let context = initialContext;
  let generation = 0;
  const link = document.createElement("a");
  link.className = "discord-origin-link";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.hidden = true;
  container.append(link);

  const refresh = async () => {
    const current = ++generation;
    link.hidden = true;
    link.removeAttribute("href");
    if (!context.presented || !context.host.connection.connected) return;
    let key: string | undefined = context.props.sessionKey;
    const visited = new Set<string>();
    // Follow recorded ancestry only. Never guess Discord IDs from a session key or transcript.
    while (key && visited.size < 8 && !visited.has(key)) {
      visited.add(key);
      let result: { session: unknown };
      try {
        result = await context.host.request<{ session: unknown }>("sessions.describe", {
          key,
          ...(visited.size === 1 ? { agentId: context.props.agentId } : {}),
        });
      } catch {
        if (current === generation) link.hidden = true;
        return;
      }
      if (context.signal.aborted || current !== generation) return;
      const parsed = sessionSchema.safeParse(result.session);
      if (!parsed.success) return;
      const row = parsed.data;
      if (row.origin?.provider === "discord") {
        // Spawned runs can retain the canonical Discord delivery target without nativeChannelId.
        const channelId = String(
          row.origin.threadId ??
            row.origin.nativeChannelId ??
            row.origin.to?.match(/^channel:(\d{17,20})$/u)?.[1] ??
            "",
        );
        const guildId = row.origin.chatType === "direct" ? "@me" : row.space;
        if (
          !snowflake.test(channelId) ||
          !guildId ||
          (guildId !== "@me" && !snowflake.test(guildId))
        )
          return;
        link.href = `https://discord.com/channels/${guildId}/${channelId}`;
        link.textContent = row.origin.threadId ? "Discord Thread ↗" : "Discord Conversation ↗";
        link.title =
          visited.size > 1
            ? "Open the Discord conversation that started the parent session"
            : "Return to this session’s Discord conversation";
        link.hidden = false;
        return;
      }
      if (row.origin?.provider && row.origin.provider !== "webchat") return;
      key = row.parentSessionKey ?? row.spawnedBy;
    }
  };
  const load = () => void refresh();
  load();
  return {
    update(next) {
      const changed =
        next.props.sessionKey !== context.props.sessionKey ||
        next.props.agentId !== context.props.agentId ||
        next.presented !== context.presented;
      context = next;
      if (changed) load();
    },
    dispose() {
      generation++;
      link.remove();
    },
  };
};

export default defineControlUiPlugin({
  id: "discord",
  activate(host) {
    return host.ui.registerAccessory({
      id: "conversation-origin",
      placement: "session-header",
      mount,
    });
  },
});
