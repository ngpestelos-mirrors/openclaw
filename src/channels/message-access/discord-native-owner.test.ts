import { expect, it } from "vitest";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { withDiscordNativeAdminFixture } from "./discord-native-owner.test-support.js";

it("carries current Team-admin authority through registered slash commands without bypassing admission", async () => {
  await withDiscordNativeAdminFixture(async ({ cfg, profile, publishConfig, run, dispatch }) => {
    publishConfig();
    const expectDenied = async () => {
      expect((await run()).followUp).toHaveBeenCalledWith({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      });
      expect(dispatch).not.toHaveBeenCalled();
    };
    await run();
    expect(dispatch).toHaveBeenCalledOnce();
    const ctx = dispatch.mock.calls[0]![0].ctx;
    expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true })).toMatchObject({
      senderIsOwner: true,
      isAuthorizedSender: true,
    });
    cfg.commands!.allowFrom = { discord: [] };
    publishConfig();
    await expectDenied();
    delete cfg.commands!.allowFrom;
    publishConfig();
    setUserProfileRole(profile.id, "member");
    await expectDenied();
    expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true }).senderIsOwner).toBe(
      false,
    );
  });
});
