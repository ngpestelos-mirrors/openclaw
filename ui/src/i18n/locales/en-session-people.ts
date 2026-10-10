import { defineEnglishCatalog } from "../lib/english-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// People-picker copy follows its deferred menu renderer, not the application boot path.
const enSessionPeople = {
  sessionsView: {
    searchPeople: "Search people and agents…",
    noPeopleMatch: "No matching people or agents",
  },
} satisfies TranslationMap;

export const registerSessionPeopleEnglish = defineEnglishCatalog(
  () => {
    Object.assign(en.sessionsView, enSessionPeople.sessionsView);
  },
  { catalog: enSessionPeople },
);
