import { describe, expect, it } from "vitest";
import { questionUnderName } from "./PendingApproval";

describe("the approval card's question", () => {
  it("drops the asker's name the titlebar already shows", () => {
    expect(questionUnderName("Echo wants to send an email", "Echo")).toBe("Wants to send an email");
  });

  it("keeps a line that does not lead with the name", () => {
    expect(questionUnderName("Approve this request", "Echo")).toBe("Approve this request");
    expect(questionUnderName("Echoes wants to run", "Echo")).toBe("Echoes wants to run");
    expect(questionUnderName("Echo wants to run", undefined)).toBe("Echo wants to run");
  });
});
