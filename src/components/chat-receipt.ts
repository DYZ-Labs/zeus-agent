export type ChatReceipt = {
  messageId: number;
  recalled: number;
  recalledFacts: number;
  recalledEpisodes: number;
  recalledFacets: number;
  accepted: number;
  acceptedFacets: number;
  pending: number;
  pendingFacets: number;
  goalsUpdated: number;
  commitmentsUpdated: number;
  superseded: number;
  failed: boolean;
};

/** Keep a no-op memory pass out of the reply chrome while retaining meaningful receipts. */
export function receiptSummaryParts(receipt: ChatReceipt): string[] {
  return [
    receipt.recalled > 0 ? `${receipt.recalled} recalled` : null,
    receipt.failed
      ? "extraction failed"
      : receipt.accepted > 0
        ? `${receipt.accepted} accepted`
        : null,
    receipt.pending > 0 ? `${receipt.pending} pending` : null,
    receipt.superseded > 0 ? `${receipt.superseded} superseded` : null,
  ].filter((part): part is string => part !== null);
}
