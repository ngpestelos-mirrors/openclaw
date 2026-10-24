// @vitest-environment node
import type { SystemAgentChatQuestion } from "@openclaw/gateway-protocol";
import { describe, expect, it } from "vitest";
import { createCustodianReplyMessage } from "./transcript.ts";

describe("custodian typed question", () => {
  it("accepts a valid typed question and keeps replies and recommendations", () => {
    const question: SystemAgentChatQuestion = {
      id: " onboarding-next-step ",
      header: " Next step ",
      question: " What would you like to do first? ",
      options: [
        { label: " Talk to my agent ", reply: " talk to agent ", recommended: true },
        { label: " Connect WhatsApp ", reply: " connect whatsapp ", description: " Chat there. " },
      ],
      isOther: true,
      skipAction: "exit",
    };
    expect(
      createCustodianReplyMessage(1, {
        sessionId: "custodian-session",
        reply: "Ready",
        action: "none",
        question,
      }).question,
    ).toEqual({
      id: "onboarding-next-step",
      header: "Next step",
      question: "What would you like to do first?",
      options: [
        { label: "Talk to my agent", reply: "talk to agent", recommended: true },
        { label: "Connect WhatsApp", reply: "connect whatsapp", description: "Chat there." },
      ],
      isOther: true,
      skipAction: "exit",
    });
  });

  it("accepts wizard-style questions without any recommendation", () => {
    const parsed = createCustodianReplyMessage(1, {
      sessionId: "custodian-session",
      reply: "Ready",
      action: "none",
      question: {
        id: "channel",
        header: "Channel",
        question: "Which channel?",
        options: [{ label: "WhatsApp" }, { label: "Telegram" }],
      },
    }).question;
    expect(parsed?.options).toHaveLength(2);
    expect(parsed?.isOther).toBe(false);
  });

  it("omits absent questions and display text that is empty after trimming", () => {
    expect(
      createCustodianReplyMessage(1, {
        sessionId: "custodian-session",
        reply: "Ready",
        action: "none",
      }).question,
    ).toBeNull();
    expect(
      createCustodianReplyMessage(1, {
        sessionId: "custodian-session",
        reply: "Ready",
        action: "none",
        question: {
          id: "blank-label",
          header: "H",
          question: "Q",
          options: [{ label: "A" }, { label: "   " }],
        },
      }).question,
    ).toBeNull();
  });
});
