import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SkillWorkshopChangeNotice } from "../../../../../src/shared/skill-workshop-change-notice.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { toolIcons } from "../../../components/icons-tools.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import "../../../styles/chat/skill-learned-notice.css";

/**
 * A background skill review's changes as one quiet row. Each skill links to the Workshop;
 * reverting stays conversational ("undo"), where the agent holds the exact revert.
 */
class ChatSkillLearnedNotice extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @property({ attribute: false }) notice?: SkillWorkshopChangeNotice;

  private openSkill(name: string) {
    this.context?.navigate("skill-workshop", { search: `?skill=${encodeURIComponent(name)}` });
  }

  override render() {
    const notice = this.notice;
    if (!notice) {
      return nothing;
    }
    return html`
      <div class="chat-skill-notice" role="group" aria-label=${t("chat.skillLearned.label")}>
        <div class="chat-skill-notice__header">
          <span class="chat-skill-notice__icon" aria-hidden="true">${toolIcons.wrench}</span>
          <span class="chat-skill-notice__label">${t("chat.skillLearned.label")}</span>
          <span class="chat-skill-notice__hint">${t("chat.skillLearned.undoHint")}</span>
        </div>
        <ul class="chat-skill-notice__skills">
          ${notice.skills.map(
            (skill) => html`
              <li class="chat-skill-notice__skill">
                <span class="chat-skill-notice__action"
                  >${t(`chat.skillLearned.${skill.action}`)}</span
                >
                <button
                  type="button"
                  class="chat-skill-notice__name"
                  title=${t("chat.skillLearned.open", { name: skill.name })}
                  @click=${() => this.openSkill(skill.name)}
                >
                  ${skill.name}
                </button>
                <span class="chat-skill-notice__summary">${skill.summary ?? ""}</span>
              </li>
            `,
          )}
        </ul>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-skill-learned-notice")) {
  customElements.define("openclaw-chat-skill-learned-notice", ChatSkillLearnedNotice);
}
