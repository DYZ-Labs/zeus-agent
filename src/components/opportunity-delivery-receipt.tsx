"use client";

import { useEffect } from "react";
import type { ResourceId } from "@/core/contracts";

export function OpportunityDeliveryReceipt({ opportunityId }: { opportunityId: ResourceId }) {
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
