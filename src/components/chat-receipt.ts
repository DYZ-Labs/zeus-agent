/**
 * What a turn did to memory.
 *
 * The chat no longer renders this. It is still carried on the turn because two things
 * depend on it: the reply is only finished once it arrives, and a follow-through decision
 * needs the assistant message it was shown against. The provenance itself lives in
 * `response_context` and is reachable at /response/[id].
 */
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
