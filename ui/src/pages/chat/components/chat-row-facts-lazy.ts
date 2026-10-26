import { lazy } from "solid-js";

export const ChatNotice = lazy(() => import("./chat-notice-view.tsx"), {
  export: "ChatNotice",
});

export const ActivityGroupContent = lazy(() => import("./chat-message-activity-view.tsx"), {
  export: "ActivityGroupContent",
});
