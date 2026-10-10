import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  {
    surface: "publication",
    load: () => import("../pages/chat/components/chat-github-publication.ts"),
  },
  {
    surface: "pull requests",
    load: () => import("../pages/chat/components/chat-pull-requests.ts"),
  },
  {
    surface: "connections",
    load: () => import("../features/github-connections/github-connections.ts"),
  },
  {
    surface: "identity",
    load: () => import("../features/github-connections/github-identity-view.ts"),
  },
])("loads GitHub fallback copy at the cold $surface boundary", async ({ load }) => {
  const { en, manager } = await loadI18n({
    githubConnections: { manage: "Verbindungen verwalten" },
  });
  const connections = en.githubConnections;
  const publication = en.githubPublication;
  expect(connections.manage).toBeUndefined();
  expect(publication.failedAttempt).toBeUndefined();
  expect(manager.t("githubPublication.newAction")).toBe("Choose a new publication");
  expect(manager.t("githubPublication.capacity", { newAction: "Next" })).toContain("Next");
  expect(
    ["title", "mine", "system", "forMe", "forSystem"].map((key) =>
      manager.t("githubConnections." + key),
    ),
  ).toEqual(["GitHub connections", "My GitHub", "System GitHub", "For me", "For the system"]);
  await manager.setLocale("de");
  await load();
  expect(en.githubConnections).toBe(connections);
  expect(en.githubPublication).toBe(publication);
  expect(manager.t("githubConnections.manage")).toBe("Verbindungen verwalten");
  expect(manager.t("githubPublication.failedAttempt")).toBe("Publication attempt failed");
  expect(manager.t("githubPublication.sharedUnavailable.changed")).toBe(
    "The Gateway GitHub account changed. Reload and retry publication.",
  );
  const { registerGitHubEnglish } = await import("./locales/en-github.ts");
  registerGitHubEnglish();
  expect(en.githubConnections).toBe(connections);
  expect(en.githubPublication).toBe(publication);
  expect(manager.t("githubConnections.manage")).toBe("Verbindungen verwalten");
});
