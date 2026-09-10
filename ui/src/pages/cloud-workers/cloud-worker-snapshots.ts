import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  ProjectsListResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsSummary,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDurationHuman, formatRelativeTimestamp } from "../../lib/format.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

registerSettingsEnglish();

type SnapshotImage = {
  profileKey: string;
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  projectKey?: string;
  projectLabel?: string;
  projectRoot?: string;
  checkpointId?: string;
  state: "pending" | "available" | "no-image";
  createdAtMs?: number;
  lastDemandAtMs?: number | null;
  baseCommit?: string;
  runtimeIdentity?: { nodeBootstrapSha256: string };
  held: boolean;
  allocationCount: number;
  retirement?: { checkpointId: string };
  capture?: {
    selector: string;
    leaseId?: string;
    phase: "scrubbing" | "creating" | "uncertain";
    stale: boolean;
  };
};
type SnapshotProfile = {
  id: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  warmImages: "on" | "off";
  reason: string;
};
type SnapshotsResult = {
  images: SnapshotImage[];
  profiles: SnapshotProfile[];
  legacyLeases: { leaseId: string; selector: string; recoveryHint: string }[];
};

class CloudWorkerSnapshots extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private result: SnapshotsResult | null = null;
  @state() private loading = false;
  @state() private recovering: string | null = null;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private builds: EnvironmentSummary[] = [];
  @state() private buildDialog = false;
  @state() private buildProfile = "";
  @state() private buildProject = "";
  @state() private repositories: { root: string; label: string }[] = [];
  @state() private repositoriesLoading = false;
  @state() private buildError: string | null = null;
  @state() private preparing = false;
  @state() private cancelling: string | null = null;
  private refreshAgain = false;
  private pickerGeneration = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmation: AbortController | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.refreshAgain = false;
      this.stopPolling();
      this.closeBuildDialog();
      this.builds = [];
      this.preparing = false;
      this.cancelling = null;
      this.result = null;
      this.loading = false;
      this.recovering = null;
      this.error = null;
      this.notice = null;
      this.confirmation?.abort();
    },
    ensureInitialData: () => void this.load(),
  });

  private canCall(method: string) {
    return canCallGatewayMethod(this.gateway.snapshot, method, "operator.admin");
  }

  private async load() {
    const scope = this.gateway.capture();
    if (this.loading) {
      this.refreshAgain = true;
      return;
    }
    if (!scope || !this.canCall("crabbox.images.list")) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const [result, environments] = await Promise.all([
        scope.client.request<SnapshotsResult>("crabbox.images.list", {}),
        scope.client.request<EnvironmentsListResult>("environments.list", {}),
      ]);
      if (this.gateway.isCurrent(scope)) {
        this.result = result;
        this.builds = environments.environments.filter(
          (environment) =>
            environment.preparation?.purpose === "build" &&
            environment.worker &&
            ["requested", "provisioning", "bootstrapping"].includes(environment.worker.state),
        );
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.loading = false;
        this.stopPolling();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          void this.load();
        } else if (this.builds.length) {
          this.pollTimer = setTimeout(() => void this.load(), 10_000);
        }
      }
    }
  }

  private stopPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private closeBuildDialog() {
    this.pickerGeneration += 1;
    this.buildDialog = false;
    this.repositories = [];
    this.repositoriesLoading = false;
    this.buildError = null;
  }

  private async openBuildDialog() {
    const scope = this.gateway.capture();
    if (!scope || !this.canCall("environments.prepare") || this.preparing) {
      return;
    }
    const generation = ++this.pickerGeneration;
    this.buildDialog = true;
    this.buildProfile = "";
    this.buildProject = "";
    this.buildError = null;
    this.repositories = [];
    this.repositoriesLoading = true;
    const current = () => this.gateway.isCurrent(scope) && generation === this.pickerGeneration;
    try {
      // Use the same Gateway-local catalog as New Session, including managed repository roots.
      const [projects, worktrees] = await Promise.all([
        scope.client.request<ProjectsListResult>("projects.list", {}),
        scope.client.request<WorktreesListResult>("worktrees.list", {}),
      ]);
      if (current()) {
        const roots = new Map<string, string>();
        for (const project of projects.projects) {
          if (project.repoRoot) {
            roots.set(project.repoRoot, project.displayName);
          }
        }
        for (const worktree of worktrees.worktrees) {
          if (!worktree.removedAt && !roots.has(worktree.repoRoot)) {
            roots.set(worktree.repoRoot, worktree.repoRoot);
          }
        }
        this.repositories = [...roots].map(([root, label]) => ({ root, label }));
      }
    } catch (error) {
      if (current()) {
        this.buildError = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.repositoriesLoading = false;
      }
    }
  }

  private async prepare(profileId: string, projectPath: string, fromDialog = false) {
    const scope = this.gateway.capture();
    if (!scope || this.preparing || !this.canCall("environments.prepare")) {
      return;
    }
    const eligible = this.result?.profiles.some(
      (profile) => profile.id === profileId && profile.warmImages === "on",
    );
    if (
      !eligible ||
      !projectPath ||
      (fromDialog && !this.repositories.some((repository) => repository.root === projectPath))
    ) {
      this.buildError = t("cloudWorkersPage.snapshots.selectBuildInputs");
      return;
    }
    this.preparing = true;
    this.buildError = null;
    this.error = null;
    this.notice = null;
    try {
      const result = await scope.client.request<{ reused: boolean }>("environments.prepare", {
        profileId,
        projectPath,
      });
      if (this.gateway.isCurrent(scope)) {
        this.closeBuildDialog();
        this.notice = t(
          result.reused
            ? "cloudWorkersPage.snapshots.buildReused"
            : "cloudWorkersPage.snapshots.buildStarted",
        );
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        const code =
          error instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(error) : null;
        const message =
          code === "capacity"
            ? t("cloudWorkersPage.snapshots.capacity")
            : code === "invalid_project"
              ? t("cloudWorkersPage.snapshots.invalidProject")
              : code === "invalid_profile" || code === "profile_not_found"
                ? t("cloudWorkersPage.snapshots.invalidProfile")
                : formatUiError(error);
        if (fromDialog) {
          this.buildError = message;
        } else {
          this.error = message;
        }
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.preparing = false;
      }
    }
  }

  private async cancelBuild(environment: EnvironmentSummary) {
    const scope = this.gateway.capture();
    if (!scope || this.cancelling || this.confirmation || !this.canCall("environments.destroy")) {
      return;
    }
    const confirmation = new AbortController();
    this.confirmation = confirmation;
    const confirmed = await showConfirmDialog({
      title: t("cloudWorkersPage.snapshots.cancelBuild"),
      message: t("cloudWorkersPage.snapshots.cancelBuildMessage"),
      details: environment.id,
      confirmLabel: t("cloudWorkersPage.snapshots.cancelBuild"),
      danger: true,
      signal: confirmation.signal,
    });
    if (this.confirmation === confirmation) {
      this.confirmation = null;
    }
    if (!confirmed || !this.gateway.isCurrent(scope) || !this.canCall("environments.destroy")) {
      return;
    }
    this.cancelling = environment.id;
    this.error = null;
    this.notice = null;
    try {
      await scope.client.request("environments.destroy", { environmentId: environment.id });
      if (this.gateway.isCurrent(scope)) {
        this.notice = t("cloudWorkersPage.snapshots.buildCancelled");
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.cancelling = null;
      }
    }
  }

  private renderBuildDialog() {
    if (!this.buildDialog) {
      return nothing;
    }
    const valid =
      this.result?.profiles.some(
        (profile) => profile.id === this.buildProfile && profile.warmImages === "on",
      ) && this.repositories.some((repository) => repository.root === this.buildProject);
    return html`<openclaw-modal-dialog
      label=${t("cloudWorkersPage.snapshots.buildSnapshot")}
      @modal-cancel=${(event: Event) => {
        if (this.preparing) {
          event.preventDefault();
        } else {
          this.closeBuildDialog();
        }
      }}
    >
      <div class="exec-approval-card">
        <h2>${t("cloudWorkersPage.snapshots.buildSnapshot")}</h2>
        <p>${t("cloudWorkersPage.snapshots.buildHelp")}</p>
        <label class="field"
          ><span>${t("cloudWorkersPage.snapshots.profile")}</span>
          <select
            class="settings-select"
            .value=${this.buildProfile}
            ?disabled=${this.preparing}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                this.buildProfile = event.currentTarget.value;
              }
            }}
          >
            <option value="">${t("cloudWorkersPage.snapshots.chooseProfile")}</option>
            ${this.result?.profiles.map((profile) => html`<option value=${profile.id} ?disabled=${profile.warmImages !== "on"}>${profile.id}${profile.warmImages === "on" ? "" : ` — ${profile.reason}`}</option>`)}
          </select>
        </label>
        <label class="field"
          ><span>${t("cloudWorkersPage.snapshots.repository")}</span>
          <select
            class="settings-select"
            .value=${this.buildProject}
            ?disabled=${this.preparing || this.repositoriesLoading}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                this.buildProject = event.currentTarget.value;
              }
            }}
          >
            <option value="">
              ${t(this.repositoriesLoading ? "common.loading" : "cloudWorkersPage.snapshots.chooseRepository")}
            </option>
            ${this.repositories.map((repository) => html`<option value=${repository.root}>${repository.label === repository.root ? repository.root : `${repository.label} · ${repository.root}`}</option>`)}
          </select>
        </label>
        ${!this.repositoriesLoading && !this.repositories.length && !this.buildError ? html`<p>${t("cloudWorkersPage.snapshots.noRepositories")}</p>` : nothing}
        ${this.buildError ? html`<div class="callout warning" role="alert">${this.buildError}</div>` : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            type="button"
            ?disabled=${!valid || this.preparing || !this.canCall("environments.prepare")}
            @click=${() => void this.prepare(this.buildProfile, this.buildProject, true)}
          >
            ${t("cloudWorkersPage.snapshots.buildSnapshot")}
          </button>
          <button
            class="btn"
            type="button"
            ?disabled=${this.preparing}
            @click=${() => this.closeBuildDialog()}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>`;
  }

  private renderBuildRow(environment: EnvironmentSummary) {
    const worker = environment.worker;
    if (!worker) {
      return nothing;
    }
    return renderSettingsRow({
      title: t("cloudWorkersPage.snapshots.building"),
      description: html`${environment.id} ·
      ${t(`cloudWorkersPage.snapshots.buildStates.${worker.state}`)} ·
      ${t("cloudWorkersPage.snapshots.buildAge", { age: formatDurationHuman(worker.ageMs) })}`,
      control: this.canCall("environments.destroy")
        ? html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${this.cancelling !== null}
            @click=${() => void this.cancelBuild(environment)}
          >
            ${t("common.cancel")}
          </button>`
        : nothing,
    });
  }

  private async recover(image: SnapshotImage) {
    const scope = this.gateway.capture();
    const selector = image.capture?.selector;
    if (
      !scope ||
      !selector ||
      image.capture?.phase !== "uncertain" ||
      this.recovering ||
      this.confirmation ||
      !this.canCall("crabbox.images.recover")
    ) {
      return;
    }
    const confirmation = new AbortController();
    this.confirmation = confirmation;
    const confirmed = await showConfirmDialog({
      title: t("cloudWorkersPage.snapshots.recoverTitle"),
      message: t("cloudWorkersPage.snapshots.recoverMessage"),
      details: selector,
      confirmLabel: t("cloudWorkersPage.snapshots.recover"),
      requiredAcknowledgement: t("cloudWorkersPage.snapshots.acknowledgement"),
      signal: confirmation.signal,
    });
    if (this.confirmation === confirmation) {
      this.confirmation = null;
    }
    if (!confirmed) {
      return;
    }
    if (!this.gateway.isCurrent(scope) || !this.canCall("crabbox.images.recover")) {
      this.error = t("cloudWorkersPage.snapshots.recoveryChanged");
      return;
    }
    this.recovering = selector;
    this.error = null;
    this.notice = null;
    try {
      await scope.client.request("crabbox.images.recover", {
        selector,
        acknowledgeProviderCleanup: true,
      });
      if (this.gateway.isCurrent(scope)) {
        this.notice = t("cloudWorkersPage.snapshots.recovered");
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.recovering = null;
      }
    }
  }

  private renderImage(image: SnapshotImage, showMachineFacts: boolean) {
    const { profileId, projectRoot } = image;
    const phase = image.capture?.phase;
    const retiringCurrentImage = Boolean(
      image.retirement && image.retirement.checkpointId === image.checkpointId,
    );
    const imageState =
      phase ??
      (retiringCurrentImage ? "retiring" : image.state === "no-image" ? "noImage" : image.state);
    const runtimeDigest = image.runtimeIdentity?.nodeBootstrapSha256.slice(0, 12);
    const facts = [
      ...(showMachineFacts ? [image.backend, image.machineClass, image.os] : []),
      ...(image.baseCommit
        ? [t("cloudWorkersPage.snapshots.baseCommit", { commit: image.baseCommit.slice(0, 8) })]
        : []),
      ...(image.createdAtMs != null
        ? [
            t("cloudWorkersPage.snapshots.created", {
              age: formatRelativeTimestamp(image.createdAtMs),
            }),
          ]
        : []),
      ...(image.lastDemandAtMs != null
        ? [
            t("cloudWorkersPage.snapshots.lastUsed", {
              age: formatRelativeTimestamp(image.lastDemandAtMs),
            }),
          ]
        : []),
      t("cloudWorkersPage.snapshots.allocations", { count: String(image.allocationCount) }),
      ...(runtimeDigest
        ? [t("cloudWorkersPage.snapshots.runtime", { digest: runtimeDigest })]
        : []),
    ];
    return renderSettingsRow({
      title: image.projectKey
        ? (image.projectLabel ?? t("cloudWorkersPage.snapshots.projectImage"))
        : t("cloudWorkersPage.snapshots.machineImage"),
      description: html`
        ${facts.filter(Boolean).join(" · ")}
        ${
          image.retirement
            ? html`<br />${t("cloudWorkersPage.snapshots.retirementHint", {
                  checkpoint: image.retirement.checkpointId,
                })}`
            : nothing
        }
      `,
      stackedOnNarrow: true,
      control: html`
        ${renderSettingsStatus({
          kind:
            phase === "uncertain" || retiringCurrentImage
              ? "warn"
              : phase
                ? "accent"
                : image.state === "available"
                  ? "ok"
                  : "muted",
          label: t(`cloudWorkersPage.snapshots.${imageState}`),
        })}
        ${
          image.retirement
            ? renderSettingsStatus({
                kind: "warn",
                label: t("cloudWorkersPage.snapshots.retirementPending"),
              })
            : nothing
        }
        ${
          projectRoot &&
          profileId &&
          this.result?.profiles.some(
            (profile) => profile.id === profileId && profile.warmImages === "on",
          ) &&
          this.canCall("environments.prepare")
            ? html`<button
                class="btn btn--sm"
                type="button"
                ?disabled=${this.preparing || this.loading}
                @click=${() => void this.prepare(profileId, projectRoot)}
              >
                ${t("cloudWorkersPage.snapshots.rebuild")}
              </button>`
            : nothing
        }
        ${
          phase === "uncertain" && this.canCall("crabbox.images.recover")
            ? html`
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${this.recovering !== null || this.loading}
                  @click=${() => void this.recover(image)}
                >
                  ${t("cloudWorkersPage.snapshots.recover")}
                </button>
              `
            : nothing
        }
      `,
    });
  }

  private renderImages(result: SnapshotsResult) {
    const groups = new Map<
      string | undefined,
      { profile?: SnapshotProfile; images: SnapshotImage[]; builds: EnvironmentSummary[] }
    >(result.profiles.map((profile) => [profile.id, { profile, images: [], builds: [] }]));
    for (const image of result.images) {
      const group = groups.get(image.profileId) ?? { images: [], builds: [] };
      group.images.push(image);
      groups.set(image.profileId, group);
    }
    for (const environment of this.builds) {
      const profileId = environment.worker?.profileId;
      const group = groups.get(profileId) ?? { images: [], builds: [] };
      group.builds.push(environment);
      groups.set(profileId, group);
    }
    const buildLeases = new Set(
      this.builds.flatMap((environment) =>
        environment.worker?.leaseId ? [environment.worker.leaseId] : [],
      ),
    );
    return html`
      ${renderSettingsSummary([
        {
          label: t("cloudWorkersPage.snapshots.images"),
          value: result.images.filter((image) => image.checkpointId).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.building"),
          value:
            this.builds.length +
            result.images.filter(
              (image) =>
                image.capture &&
                image.capture.phase !== "uncertain" &&
                (!image.capture.leaseId || !buildLeases.has(image.capture.leaseId)),
            ).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.held"),
          value: result.images.filter((image) => image.held).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.attention"),
          value: result.images.filter(
            (image) =>
              image.retirement || image.capture?.phase === "uncertain" || image.capture?.stale,
          ).length,
        },
      ])}
      ${
        groups.size
          ? [...groups].map(([id, group]) => {
              const metadata = (["backend", "machineClass", "os"] as const).map((key) => {
                const values = Array.from(
                  new Set(group.images.map((image) => image[key]).filter(Boolean)),
                );
                const configured = group.profile?.[key];
                return values.length ? values : configured ? [configured] : [];
              });
              const facts = metadata.map((values) => values.join(", ")).filter(Boolean);
              const mixedMetadata = metadata.some((values) => values.length > 1);
              if (group.profile) {
                facts.push(
                  t(
                    group.profile.warmImages === "on"
                      ? "cloudWorkersPage.snapshots.warmOn"
                      : "cloudWorkersPage.snapshots.warmOff",
                  ),
                  group.profile.reason,
                );
              }
              return renderSettingsSection(
                {
                  title: id ?? t("cloudWorkersPage.snapshots.unlabeledProfile"),
                  description: facts.join(" · "),
                  count: group.images.length + group.builds.length,
                },
                group.images.length || group.builds.length
                  ? html`${group.builds.map((entry) => this.renderBuildRow(entry))}${group.images.map((entry) => this.renderImage(entry, mixedMetadata))}`
                  : renderSettingsEmpty(t("cloudWorkersPage.snapshots.profileEmpty")),
              );
            })
          : renderSettingsEmpty(t("cloudWorkersPage.snapshots.empty"))
      }
      ${
        result.legacyLeases.length
          ? renderSettingsSection(
              {
                title: t("cloudWorkersPage.snapshots.migration"),
                description: t("cloudWorkersPage.snapshots.migrationHint"),
              },
              result.legacyLeases.map((lease) =>
                renderSettingsRow({ title: lease.leaseId, description: lease.recoveryHint }),
              ),
            )
          : nothing
      }
    `;
  }

  override render() {
    const advertised =
      isGatewayMethodAdvertised(this.gateway.snapshot ?? {}, "crabbox.images.list") === true;
    if (!advertised || !this.canCall("crabbox.images.list")) {
      return renderSettingsPage(
        renderSettingsEmpty(
          t(
            advertised
              ? "cloudWorkersPage.snapshots.adminRequired"
              : "cloudWorkersPage.snapshots.unavailable",
          ),
        ),
      );
    }
    return renderSettingsPage(html`
      ${renderSettingsSection(
        {},
        renderSettingsRow({
          title: t("cloudWorkersPage.snapshots.title"),
          control: html`${this.canCall("environments.prepare") ? html`<button class="btn primary btn--sm" type="button" ?disabled=${this.loading || this.preparing} @click=${() => void this.openBuildDialog()}>${t("cloudWorkersPage.snapshots.buildSnapshot")}</button>` : nothing}<button
              class="btn btn--sm"
              type="button"
              ?disabled=${this.loading || this.recovering !== null}
              @click=${() => void this.load()}
            >
              ${t("cloudWorkersPage.snapshots.refresh")}
            </button>`,
        }),
      )}
      ${this.error ? html`<div class="callout warning" role="alert">${this.error}</div>` : nothing}
      ${this.notice ? html`<div class="callout" role="status">${this.notice}</div>` : nothing}
      ${this.result ? this.renderImages(this.result) : this.loading ? renderSettingsEmpty(t("common.loading")) : nothing}
      ${this.renderBuildDialog()}
    `);
  }
}

if (!customElements.get("openclaw-cloud-worker-snapshots")) {
  customElements.define("openclaw-cloud-worker-snapshots", CloudWorkerSnapshots);
}
