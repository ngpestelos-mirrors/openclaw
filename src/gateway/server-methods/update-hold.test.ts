import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateHandlers } from "./update.js";

type UpdateScheduleState =
  import("../../../packages/gateway-protocol/src/index.js").UpdateScheduleState;
type UpdateCampaignState = NonNullable<UpdateScheduleState["campaign"]>;
const campaign: UpdateCampaignState = {
  id: "campaign-1",
  state: "waiting-for-idle",
  announcedAtMs: 1,
  forceAtMs: 900_001,
  updatedAtMs: 1,
};
const heldCampaign = { ...campaign, holdUntilMs: 3_600_001, forceAtMs: 4_500_001 };

const holdUpdateCampaignMock = vi.hoisted(() => vi.fn(() => false));
const getUpdateCampaignStateMock = vi.hoisted(() =>
  vi.fn<() => UpdateCampaignState | undefined>(() => undefined),
);
const getUpdateScheduleMock = vi.hoisted(() => vi.fn<() => UpdateScheduleState | null>(() => null));
const campaignOwner = vi.hoisted(() => ({ present: true }));

vi.mock("../../infra/update-check-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check-lifecycle.js")>()),
  currentUpdateCheckLifecycle: () => ({
    campaign: campaignOwner.present
      ? {
          getState: getUpdateCampaignStateMock,
          hold: holdUpdateCampaignMock,
        }
      : undefined,
  }),
}));

vi.mock("../../infra/update-status-state.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: getUpdateScheduleMock,
}));

vi.mock("./validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./validation.js")>()),
  assertValidParams: () => true,
}));

beforeEach(() => {
  campaignOwner.present = true;
  holdUpdateCampaignMock.mockReset().mockReturnValue(false);
  getUpdateCampaignStateMock.mockReset().mockReturnValue(undefined);
  getUpdateScheduleMock.mockReset().mockReturnValue(null);
});

async function invokeUpdateHold() {
  const respond = vi.fn();
  const logInfo = vi.fn();
  await expectDefined(
    updateHandlers["update.hold"],
    'updateHandlers["update.hold"] test invariant',
  )({
    params: {},
    respond,
    client: {
      connId: "conn-1",
      clientIp: "127.0.0.1",
      connect: { client: { id: "control-ui" }, device: { id: "device-1" } },
    },
    context: { logGateway: { info: logInfo } },
  } as never);
  return { respond, logInfo };
}

describe("update.hold", () => {
  it("holds the active campaign and returns the updated schedule", async () => {
    holdUpdateCampaignMock.mockReturnValueOnce(true);
    getUpdateScheduleMock.mockReturnValueOnce({
      channel: "beta",
      autoEnabled: true,
      campaign: heldCampaign,
    });
    getUpdateCampaignStateMock.mockReturnValueOnce(campaign).mockReturnValueOnce(heldCampaign);
    const { respond, logInfo } = await invokeUpdateHold();

    const result = {
      ok: true,
      schedule: expect.objectContaining({
        campaign: expect.objectContaining({ holdUntilMs: 3_600_001 }),
      }),
    };
    expect(holdUpdateCampaignMock).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, result);
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringMatching(
        /^update\.hold granted actor=control-ui .*holdUntilMs=3600001 forceAtMs=4500001$/,
      ),
    );
  });

  it("returns ok=false when there is no active campaign", async () => {
    campaignOwner.present = false;
    const { respond, logInfo } = await invokeUpdateHold();

    expect(respond).toHaveBeenCalledWith(true, { ok: false });
    expect(holdUpdateCampaignMock).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringMatching(/^update\.hold refused actor=control-ui /),
      { reason: "no campaign" },
    );
  });

  it.each([
    {
      name: "an applying campaign",
      campaign: { ...campaign, state: "applying" as const },
      reason: "applying",
    },
    {
      name: "an already-held campaign",
      campaign: heldCampaign,
      reason: "already held",
    },
  ])("logs why $name cannot be held", async ({ campaign: currentCampaign, reason }) => {
    getUpdateCampaignStateMock.mockReturnValueOnce(currentCampaign);
    const { logInfo } = await invokeUpdateHold();

    expect(logInfo).toHaveBeenCalledWith(
      expect.stringMatching(/^update\.hold refused actor=control-ui /),
      { reason },
    );
  });
});
