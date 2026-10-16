import type { JSX as SolidJSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { SessionBackgroundView } from "../../components/session-background-view.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { PresentationValue } from "../../lit/presentation-binding.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import { usePanePresentation } from "./chat-pane-embedded-view.tsx";
import { PaneDetails, type PaneDetailsProps } from "./chat-pane-header-view.tsx";
import { SidebarRegionView, type SidebarRegionViewProps } from "./chat-pane-sidebar-view.tsx";
import { ChatBoardResetConfirmation } from "./chat-pane-surfaces.tsx";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatTopbarNotices } from "./chat-view-notices.tsx";
import { ChatView, type ChatProps } from "./chat-view.tsx";
import { ChatImageLightbox } from "./components/chat-image-lightbox-view.tsx";

export function PaneOutboxRecovery(props: {
  state: ChatPageHost;
  identity: string;
  onRestored: () => void;
}) {
  return (
    <openclaw-chat-outbox-recovery
      prop:host={props.state}
      prop:messages={props.state.chatMessages}
      prop:identity={props.identity}
      onOutbox-restored={() => props.onRestored()}
    />
  );
}

export function PaneSubagentStop(props: { onAbort: () => void }) {
  return (
    <button
      class="chat-subagent-detail__stop"
      type="button"
      aria-label={t("chat.runControls.stopGenerating")}
      onClick={() => props.onAbort()}
    >
      <Icon name="stop" />
      <span>{t("chat.runControls.stop")}</span>
    </button>
  );
}

export function PaneSubagentHeader(props: {
  title: string;
  onBack: () => void;
  stop: Parameters<typeof PaneSubagentStop>[0] | undefined;
  details: PaneDetailsProps | undefined;
}) {
  return (
    <header class="chat-subagent-detail__header">
      <button class="chat-subagent-detail__back" type="button" onClick={() => props.onBack()}>
        <Icon name="arrowLeft" />
        {t("chat.subagentsPanel.back")}
      </button>
      <div class="chat-subagent-detail__heading">
        <strong class="chat-subagent-detail__title">{props.title}</strong>
        <Show when={props.stop}>{(stop) => <PaneSubagentStop {...stop()} />}</Show>
        <Show when={props.details !== undefined}>
          <PaneDetails {...props.details!} />
        </Show>
      </div>
    </header>
  );
}

export function PaneHeaderContent(props: {
  header: unknown;
  notice?: Parameters<typeof renderChatTopbarNotices>[0];
  sessionKey: string;
  agentId: string;
  presentation: PresentationValue;
}) {
  const presented = usePanePresentation(() => props.presentation);
  return (
    <>
      <LitContent value={props.header} />
      {props.notice ? renderChatTopbarNotices(props.notice) : undefined}
      <openclaw-plugin-contributions
        prop:kind="session-header"
        prop:sessionKey={props.sessionKey}
        prop:agentId={props.agentId}
        prop:presented={presented()}
      />
    </>
  );
}

export type PaneLayoutData = {
  region: SidebarRegionViewProps;
  header: Parameters<typeof PaneHeaderContent>[0] | null;
  subagentHeader: Parameters<typeof PaneSubagentHeader>[0] | null;
  primary: { chat: ChatProps; application: ApplicationContext };
  background: Parameters<typeof SessionBackgroundView>[0];
  overlays: {
    presentation: PresentationValue;
    image: ImageLightboxItem | null;
    onCloseImage: () => void;
    reset: Parameters<typeof ChatBoardResetConfirmation>[0] | null;
  };
};

function PaneContent(props: { data: PaneLayoutData }) {
  const presented = usePanePresentation(() => props.data.overlays.presentation);
  const header = (
    <Show
      when={props.data.subagentHeader}
      fallback={
        <Show when={props.data.header}>{(value) => <PaneHeaderContent {...value()} />}</Show>
      }
    >
      {(value) => <PaneSubagentHeader {...value()} />}
    </Show>
  );
  const primary = (
    <div class="chat-pane-primary-column">
      <ChatView props={props.data.primary.chat} application={props.data.primary.application} />
    </div>
  );
  const background = <SessionBackgroundView {...props.data.background} />;
  return (
    <>
      <SidebarRegionView
        {...props.data.region}
        header={header}
        primary={primary}
        background={background}
      />
      <Show when={presented()}>
        <ChatImageLightbox
          item={props.data.overlays.image}
          onClose={() => props.data.overlays.onCloseImage()}
        />
        <Show when={props.data.overlays.reset}>
          {(reset) => <ChatBoardResetConfirmation {...reset()} />}
        </Show>
      </Show>
    </>
  );
}

export function PaneLayout(props: { layout: PaneLayoutData | null }): SolidJSX.Element {
  return (
    <Show
      when={props.layout}
      fallback={<main class="app-shell app-shell--booting" aria-busy="true" />}
    >
      {(layout) => (
        <Show when={layout().subagentHeader} fallback={<PaneContent data={layout()} />}>
          <section class="chat-subagent-detail">
            <PaneContent data={layout()} />
          </section>
        </Show>
      )}
    </Show>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-outbox-recovery": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-outbox-recovery"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-chat-outbox-recovery"],
            "host" | "identity" | "messages"
          >
        > & {
          "onOutbox-restored"?: () => void;
        };
    }
  }
}
