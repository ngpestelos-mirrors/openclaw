import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

type SessionPanelData = {
  dispose(): void;
  sync(input: { sessionKey: string; agentId: string; presented: boolean }): void;
  refresh(): Promise<void>;
};

/** The panel owns presentation lifetime; each data owner retains its own admission policy. */
export abstract class ChatSessionPanel<
  Data extends SessionPanelData,
> extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "main";
  @property({ type: Boolean }) presented = true;
  protected abstract clearSelection(): void;
  protected abstract readonly dataType: new (
    context: ApplicationContext,
    changed: () => void,
  ) => Data;
  protected data: Data | null = null;
  private dataContext: ApplicationContext | null = null;

  override disconnectedCallback(): void {
    this.data?.dispose();
    this.data = null;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const contextChanged = this.dataContext !== this.context;
    const parentChanged = changed.has("sessionKey") || changed.has("agentId");
    if (contextChanged || parentChanged) {
      this.clearSelection();
    }
    if (contextChanged) {
      this.data?.dispose();
      this.data = null;
      this.dataContext = this.context;
    }
    const createData = this.context && !this.data;
    if (createData) {
      this.data = new this.dataType(this.context, () => this.requestUpdate());
    }
    if (createData || parentChanged || changed.has("presented")) {
      this.data?.sync({
        sessionKey: this.sessionKey,
        agentId: this.agentId,
        presented: this.presented,
      });
    }
  }

  async refresh(): Promise<void> {
    await this.data?.refresh();
  }
}
