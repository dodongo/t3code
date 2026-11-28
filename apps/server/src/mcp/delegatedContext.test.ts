import {
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
} from "@t3tools/contracts";
import {
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";
import { buildDelegatedFirstMessage } from "./delegatedContext.ts";

describe(buildDelegatedFirstMessage, () => {
  it("returns the exact task when no context is available", () => {
    expect(buildDelegatedFirstMessage({ task: "Act", summary: null, newestFirst: [] })).toBe("Act");
  });

  it("places the summary and chronological messages before the actionable task", () => {
    const prompt = buildDelegatedFirstMessage({
      task: "Review the patch",
      summary: "Agreed scope",
      newestFirst: ["Assistant: Ready", "User: Proceed"],
    });
    expect(prompt).toContain(
      "Compaction summary:\nAgreed scope\n\nUser: Proceed\n\nAssistant: Ready\n\nTask:\nReview the patch",
    );
    expect(prompt).not.toContain("omitted");
  });

  it("drops whole oldest messages first with a single notice", () => {
    const prompt = buildDelegatedFirstMessage({
      task: "Act",
      summary: "Keep me",
      newestFirst: ["Newest", "Middle", "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS), "Oldest"],
    });
    expect(expandAssistantCitationsForProvider(prompt).length).toBeLessThanOrEqual(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
    expect(prompt.match(/conversation context omitted/g)).toHaveLength(1);
    expect(prompt).toContain("Keep me\n\nMiddle\n\nNewest\n\nTask:\nAct");
    expect(prompt).not.toContain("Oldest");
  });

  it("uses the same citation-expanded character count as provider turn start", () => {
    const marker = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("assistant"),
      text: "\u0001".repeat(8_000),
      start: 0,
      end: 8_000,
      prefix: "",
      suffix: "",
    });
    const old = "x".repeat(80_000) + marker;
    expect(old.length + 1_000).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(expandAssistantCitationsForProvider(old).length).toBeGreaterThan(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
    const prompt = buildDelegatedFirstMessage({
      task: "Act",
      summary: null,
      newestFirst: ["Newest", old],
    });
    expect(prompt).toContain("conversation context omitted");
    expect(prompt).toContain("Newest\n\nTask:\nAct");
    expect(prompt).not.toContain(marker);
  });

  it("returns the exact task when the whole summary and framing cannot fit", () => {
    expect(
      buildDelegatedFirstMessage({
        task: "Act 🧪",
        summary: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
        newestFirst: ["Discarded"],
      }),
    ).toBe("Act 🧪");
  });
});
