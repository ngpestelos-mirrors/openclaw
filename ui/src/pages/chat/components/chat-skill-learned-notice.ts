import { consume } from "@lit/context";
import type { SkillsWorkshopUndoResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type {
  SkillWorkshopChangeNotice,
  SkillWorkshopNoticeAction,
} from "../../../../../src/shared/skill-workshop-change-notice.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { toolIcons } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import "../../../styles/chat/skill-learned-notice.css";

type UndoState = "idle" | "pending" | "done" | { error: string };

const ACTION_ICONS: Record<SkillWorkshopNoticeAction, keyof typeof toolIcons> = {
  created: "plus",
  updated: "edit",
  archived: "trash",
  restored: "refresh",
};

/**
 * A background skill review's changes as one divider row: each skill opens in the Workshop,
 * and Undo reverts the whole review through `skills.workshop.undo`, which also tells the agent.
 */
class ChatSkillLearnedNotice extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @property({ attribute: false }) notice?: SkillWorkshopChangeNotice;
  private undo: UndoState = "idle";

  private readonly runUndo = async () => {
    const notice = this.notice;
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    if (!notice || !client || this.undo === "pending" || this.undo === "done") {
      return;
    }
    this.undo = "pending";
    this.requestUpdate();
    try {
      // "already-undone" is a success too: the review's changes are reverted either way.
      await client.request<SkillsWorkshopUndoResult>("skills.workshop.undo", {
        agentId: notice.agentId,
        runId: notice.runId,
      });
      this.undo = "done";
    } catch (error) {
      this.undo = { error: formatUiError(error) };
    }
    this.requestUpdate();
  };

  private openSkill(name: string) {
    this.context?.navigate("skill-workshop", { search: `?skill=${encodeURIComponent(name)}` });
  }

  private renderUndo() {
    if (this.undo === "done") {
      return html`<span class="chat-skill-notice__done" role="status"
        >${icons.check}${t("chat.skillLearned.undone")}</span
      >`;
    }
    if (
      !canCallGatewayMethod(
        this.context?.gateway.snapshot,
        "skills.workshop.undo",
        "operator.admin",
      )
    ) {
      return nothing;
    }
    const pending = this.undo === "pending";
    return html`<button
      type="button"
      class="btn btn--xs btn--ghost chat-skill-notice__undo"
      ?disabled=${pending}
      aria-busy=${pending ? "true" : "false"}
      @click=${this.runUndo}
    >
      ${pending ? html`<span class="btn__spinner" aria-hidden="true"></span>` : toolIcons.rotateCcw}
      ${pending ? t("chat.skillLearned.undoing") : t("chat.skillLearned.undo")}
    </button>`;
  }

  override render() {
    const notice = this.notice;
    if (!notice) {
      return nothing;
    }
    const undo = this.undo;
    const single = notice.skills.length === 1 ? notice.skills[0] : undefined;
    const description = typeof undo === "object" ? undefined : single?.summary;
    return html`
      <div
        class="chat-divider chat-skill-notice ${undo === "done" ? "chat-skill-notice--undone" : ""}"
        role="group"
        aria-label=${t("chat.skillLearned.label")}
      >
        <div class="chat-divider__rule">
          <span class="chat-divider__line"></span>
          <span class="chat-skill-notice__content">
            <span class="chat-divider__label">
              <span class="chat-divider__icon" aria-hidden="true">${toolIcons.spark}</span>
              <span class="chat-divider__title">${t("chat.skillLearned.label")}</span>
            </span>
            ${notice.skills.map((skill) => {
              const verb = t(`chat.skillLearned.${skill.action}`);
              const detail = skill.summary ? `${verb}: ${skill.summary}` : verb;
              return html`<button
                type="button"
                class="chip chat-skill-notice__chip"
                title=${`${detail}. ${t("chat.skillLearned.open", { name: skill.name })}`}
                aria-label=${`${detail}. ${t("chat.skillLearned.open", { name: skill.name })}`}
                @click=${() => this.openSkill(skill.name)}
              >
                <span class="chat-skill-notice__verb" aria-hidden="true"
                  >${toolIcons[ACTION_ICONS[skill.action]]}</span
                >${skill.name}
              </button>`;
            })}
            ${this.renderUndo()}
          </span>
          <span class="chat-divider__line"></span>
        </div>
        ${
          typeof undo === "object"
            ? html`<div class="chat-divider__details">
                <span class="chat-skill-notice__error" role="alert"
                  >${t("chat.skillLearned.undoError", { error: undo.error })}</span
                >
              </div>`
            : description
              ? html`<div class="chat-divider__details">
                  <span class="chat-divider__description">${description}</span>
                </div>`
              : nothing
        }
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-skill-learned-notice")) {
  customElements.define("openclaw-chat-skill-learned-notice", ChatSkillLearnedNotice);
}
