import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Transcript marker on the notice a background skill review posts after changing learned
 * skills. The row's text serves every client; the marker lets the Control UI render it natively.
 */
export const SKILL_WORKSHOP_CHANGE_NOTICE_KIND = "skill-workshop-change" as const;

const NOTICE_ACTIONS = ["created", "updated", "archived", "restored"] as const;

export type SkillWorkshopNoticeAction = (typeof NOTICE_ACTIONS)[number];

export type SkillWorkshopChangeNoticeSkill = {
  name: string;
  action: SkillWorkshopNoticeAction;
  summary?: string;
};

export type SkillWorkshopChangeNotice = {
  kind: typeof SKILL_WORKSHOP_CHANGE_NOTICE_KIND;
  skills: SkillWorkshopChangeNoticeSkill[];
};

function readNoticeSkill(value: unknown): SkillWorkshopChangeNoticeSkill | undefined {
  const skill = asOptionalRecord(value);
  const action = NOTICE_ACTIONS.find((candidate) => candidate === skill?.action);
  if (!skill || typeof skill.name !== "string" || !skill.name || !action) {
    return undefined;
  }
  return {
    name: skill.name,
    action,
    ...(typeof skill.summary === "string" && skill.summary ? { summary: skill.summary } : {}),
  };
}

/** Reads the notice marker from a transcript message; any malformed part rejects the whole row. */
export function readSkillWorkshopChangeNotice(
  message: unknown,
): SkillWorkshopChangeNotice | undefined {
  const marker = asOptionalRecord(asOptionalRecord(message)?.openclawDeliveryMirror);
  if (
    marker?.kind !== SKILL_WORKSHOP_CHANGE_NOTICE_KIND ||
    !Array.isArray(marker.skills) ||
    marker.skills.length === 0
  ) {
    return undefined;
  }
  const skills = marker.skills.map(readNoticeSkill);
  if (skills.some((skill) => skill === undefined)) {
    return undefined;
  }
  return {
    kind: SKILL_WORKSHOP_CHANGE_NOTICE_KIND,
    skills: skills.filter((skill) => skill !== undefined),
  };
}
