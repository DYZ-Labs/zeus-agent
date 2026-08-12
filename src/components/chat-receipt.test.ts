import { describe, expect, it } from "vitest";

import { receiptSummaryParts, type ChatReceipt } from "./chat-receipt";

const EMPTY_RECEIPT: ChatReceipt = {
  messageId: 1,
  recalled: 0,
  recalledFacts: 0,
  recalledEpisodes: 0,
  recalledFacets: 0,
  accepted: 0,
  acceptedFacets: 0,
  pending: 0,
  pendingFacets: 0,
  goalsUpdated: 0,
  commitmentsUpdated: 0,
  superseded: 0,
  failed: false,
};

describe("receiptSummaryParts", () => {
  it("hides the empty recalled and accepted receipt", () => {
    expect(receiptSummaryParts(EMPTY_RECEIPT)).toEqual([]);
  });

  it("keeps material memory outcomes inspectable", () => {
    expect(
      receiptSummaryParts({
        ...EMPTY_RECEIPT,
        recalled: 2,
        accepted: 1,
        pending: 3,
        superseded: 1,
      }),
    ).toEqual(["2 recalled", "1 accepted", "3 pending", "1 superseded"]);
  });

  it("still surfaces extraction failure", () => {
    expect(receiptSummaryParts({ ...EMPTY_RECEIPT, failed: true })).toEqual([
      "extraction failed",
    ]);
  });
});
