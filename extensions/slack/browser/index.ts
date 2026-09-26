import { createSessionHeaderLink, defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";

export default defineControlUiPlugin({
  id: "slack",
  activate(host) {
    return host.ui.registerAccessory({
      id: "conversation-origin",
      placement: "session-header",
      mount: createSessionHeaderLink(({ conversationLink }) =>
        conversationLink && URL.parse(conversationLink.url)?.hostname.endsWith(".slack.com")
          ? conversationLink
          : undefined,
      ),
    });
  },
});
