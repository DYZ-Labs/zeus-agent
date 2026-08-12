"use client";

import { useEffect } from "react";

export function OpportunityDeliveryReceipt({ opportunityId }: { opportunityId: number }) {
  useEffect(() => {
    void fetch(`/api/opportunities/${opportunityId}/delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "today", responseMessageId: null }),
      keepalive: true,
    }).catch(() => undefined);
  }, [opportunityId]);
  return null;
}
