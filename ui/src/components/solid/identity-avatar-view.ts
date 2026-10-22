import { createMemo, type Accessor } from "solid-js";
import {
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "../../lib/identity-avatar-context.ts";
import { resolveIdentityAvatarView } from "../../lib/identity-avatar-view.ts";
import { resolveAvatar, type IdentityAvatarInput } from "../../lib/identity-avatar.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";

export function useIdentityAvatarView(identity: Accessor<IdentityAvatarInput>) {
  let latestView: ReturnType<typeof resolveIdentityAvatarView>;
  let retryOnPublication = false;
  const gateway = useAvatarGatewayContext();
  const application = useOptionalApplication();
  const directory = application
    ? projectOwner(profileDirectory(application.gateway), (source) => source)
    : undefined;
  const input = createMemo(
    () => {
      const value = identity();
      const resolved =
        value.identity?.type === "profile" && directory
          ? directory.read().avatarIdentity(value)
          : value;
      return {
        id: resolved.id,
        name: resolved.name,
        username: resolved.username,
        profileAvatarUrl: resolved.profileAvatarUrl,
        identity: resolved.identity ? { ...resolved.identity } : undefined,
      };
    },
    {
      equals: (previous, next) =>
        !retryOnPublication &&
        previous.id === next.id &&
        previous.name === next.name &&
        previous.username === next.username &&
        previous.profileAvatarUrl === next.profileAvatarUrl &&
        previous.identity?.type === next.identity?.type &&
        previous.identity?.id === next.identity?.id,
    },
  );
  return createMemo(() => {
    gateway();
    const value = input();
    const view = resolveIdentityAvatarView(value);
    latestView = view;
    // Failed loads revisit the loader on publication so its retry TTL can expire.
    retryOnPublication = view.imageUrl === null && resolveAvatar(value).kind === "profile";
    if (view.imageUrl && typeof view.imageUrl !== "string") {
      void view.imageUrl.then((url) => {
        if (latestView === view && url === null) {
          retryOnPublication = true;
        }
      });
    }
    return view;
  });
}

/** Reset notification invalidates the projection; reads follow the owner's synchronous publication. */
export function useAvatarGatewayContext() {
  const context = projectSource(null, {
    read: readAvatarGatewayContext,
    subscribe: (_source, notify) => registerAvatarGatewayReset(notify),
    equality: "revision",
  });
  return context.read;
}
