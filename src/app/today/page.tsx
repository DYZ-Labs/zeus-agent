import { PageHeader } from "@/components/page-header";
import { OpportunityDeliveryReceipt } from "@/components/opportunity-delivery-receipt";
import { Plans } from "@/components/plans";
import { TodayRecommendation } from "@/components/today-recommendation";
import { WorkPlansPanel, type WorkPlanPanelItem } from "@/components/work-plans-panel";
import { buildEvaluationContextForTrigger, resolveTodayOpportunity } from "@/core/ambient";
import { listChatHistory } from "@/core/conversations";
import { getExperienceSettings } from "@/core/experience";
import { hasCredentials } from "@/core/openai";
import { planItems } from "@/core/plan-dtos";
import { recommendationDto } from "@/core/recommendation-dtos";
import { resourceId } from "@/core/resource-id";
import {
  getWorkPlan,
  listToolReceipts,
  listWorkArtifacts,
  listWorkPlans,
} from "@/core/work-plans";
import { evaluateOpportunity, recommendationForOpportunity } from "@/core/stewardship";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const db = await requireOwnerPageDb();
  const params = await searchParams;
  const settings = getExperienceSettings(db);
  const plans = planItems(db, params.show === "completed");
  const established = plans.length > 0 || listChatHistory(db, 1).length > 0;
  const todayContext = buildEvaluationContextForTrigger(db, "today");
  const cycle = resolveTodayOpportunity(db, todayContext) ?? evaluateOpportunity(db, todayContext);
  const recommendation = recommendationForOpportunity(db, cycle.id);
  const workItems: WorkPlanPanelItem[] = settings.labsEnabled
    ? listWorkPlans(db, { includeClosed: true, limit: 30 })
    .map((plan) => {
      const detail = getWorkPlan(db, plan.id);
      return detail
        ? {
            plan: detail.plan,
            steps: detail.steps,
            latestRun: detail.latestRun,
            artifacts: listWorkArtifacts(db, { planId: plan.id }),
            receipts: detail.latestRun ? listToolReceipts(db, detail.latestRun.id) : [],
            needsReauthorization: detail.authorization === null,
          }
        : null;
    })
        .filter((item): item is WorkPlanPanelItem => item !== null)
    : [];

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Today"
        meta={recommendation ? "one useful next action" : "nothing needs your attention"}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <section className="mt-8 max-w-[54rem]">
          {recommendation ? (
            <>
              <OpportunityDeliveryReceipt opportunityId={resourceId("opportunity", cycle.id)} />
              <TodayRecommendation recommendation={recommendationDto(recommendation)} />
            </>
          ) : (
            <div
              className="rounded-xl border border-dashed px-5 py-8"
              style={{ borderColor: "var(--shell-line-strong)" }}
            >
              <h2 className="text-base font-medium">
                {established ? "You’re all caught up." : "What would you like help following through on?"}
              </h2>
              <p className="mt-2 max-w-[60ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
                {established
                  ? "Zeus will stay quiet until there is one useful next step worth your attention."
                  : "Tell Zeus about something you want to finish, change, or keep moving."}
              </p>
              {!established && (
                <Link href="/?prompt=Help%20me%20follow%20through%20on%20something" className="mt-4 inline-block rounded-lg px-3 py-2 text-sm font-medium" style={{ background: "var(--shell-accent)", color: "#000000" }}>
                  Start a chat
                </Link>
              )}
            </div>
          )}
        </section>

        <Plans items={plans} showCompleted={params.show === "completed"} />
        {settings.labsEnabled && <WorkPlansPanel items={workItems} canExecute={hasCredentials()} />}
      </div>
    </div>
  );
}
import Link from "next/link";
