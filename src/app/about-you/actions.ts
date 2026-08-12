"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  acceptCandidateAction,
  acceptFacetCandidateAction,
  closeFacetAction,
  correctFacetAction,
  editFactAction,
  forgetFacetAction,
  forgetFactAction,
  rejectCandidateAction,
  rejectFacetCandidateAction,
  reviveFactAction,
  supersedeFactAction,
} from "@/app/actions";
import { getCandidate } from "@/core/candidates";
import { getFacet } from "@/core/facets";
import { numericResourceId, resourceId } from "@/core/resource-id";
import { requireOwnerDb } from "@/server/auth/access";

export async function correctAboutYouItemAction(formData: FormData): Promise<void> {
  const target = aboutYouTarget(formData.get("id"));
  const correction = normalizedText(formData.get("correction"), 2_000);
  if (!target || !correction) return;

  const delegated = new FormData();
  delegated.set("id", String(target.id));
  if (target.kind === "fact") {
    delegated.set("object", correction);
    await editFactAction(delegated);
  } else {
    const db = await requireOwnerDb();
    const current = getFacet(db, target.id);
    if (!current) return;
    delegated.set("statement", correction);
    delegated.set("machineEffect", current.machine_effect ?? "");
    delegated.set("structuredCondition", current.condition_json ?? "");
    await correctFacetAction(delegated);
  }
  revalidateConsumerMemory();
}

export async function closeAboutYouItemAction(formData: FormData): Promise<void> {
  const target = aboutYouTarget(formData.get("id"));
  if (!target) return;
  await delegateId(target, target.kind === "fact" ? supersedeFactAction : closeFacetAction);
  revalidateConsumerMemory();
}

export async function restoreAboutYouItemAction(formData: FormData): Promise<void> {
  const id = numericResourceId(formValue(formData.get("id")), "fact");
  if (id === null) return;
  const delegated = new FormData();
  delegated.set("id", String(id));
  await reviveFactAction(delegated);
  revalidateConsumerMemory();
}

export async function removeAboutYouItemAction(formData: FormData): Promise<void> {
  const target = aboutYouTarget(formData.get("id"));
  if (!target) return;
  await delegateId(target, target.kind === "fact" ? forgetFactAction : forgetFacetAction);
  revalidateConsumerMemory();
}

export async function saveReviewItemAction(formData: FormData): Promise<void> {
  const id = numericResourceId(formValue(formData.get("id")), "candidate");
  if (id === null) return;
  const db = await requireOwnerDb();
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.status !== "pending") return;

  const delegated = new FormData();
  delegated.set("id", String(id));
  const editedText = normalizedText(formData.get("editedText"), 1_000);
  if (candidate.kind === "facet" && editedText) {
    const payload = candidatePayload(candidate.payload);
    delegated.set("statement", editedText);
    delegated.set("machineEffect", machineEffect(payload.machine_effect));
    delegated.set("structuredCondition", structuredCondition(payload.structured_condition));
    await acceptFacetCandidateAction(delegated);
  } else {
    await acceptCandidateAction(delegated, editedText || undefined);
  }
  revalidateConsumerMemory();
}

export async function rejectReviewItemAction(formData: FormData): Promise<void> {
  const id = numericResourceId(formValue(formData.get("id")), "candidate");
  if (id === null) return;
  const candidate = getCandidate(await requireOwnerDb(), id);
  if (!candidate || candidate.status !== "pending") return;

  const delegated = new FormData();
  delegated.set("id", String(id));
  if (candidate.kind === "facet") await rejectFacetCandidateAction(delegated);
  else await rejectCandidateAction(delegated);
  revalidateConsumerMemory();
}

export async function openAboutYouSourceAction(formData: FormData): Promise<never | void> {
  const id = numericResourceId(formValue(formData.get("sourceId")), "message");
  if (id === null) return;
  redirect(`/source/${resourceId("message", id)}`);
}

type AboutYouTarget = { kind: "fact" | "facet"; id: number };

function aboutYouTarget(value: FormDataEntryValue | null): AboutYouTarget | null {
  const raw = formValue(value);
  const factId = numericResourceId(raw, "fact");
  if (factId !== null) return { kind: "fact", id: factId };
  const facetId = numericResourceId(raw, "facet");
  return facetId === null ? null : { kind: "facet", id: facetId };
}

async function delegateId(
  target: AboutYouTarget,
  action: (formData: FormData) => Promise<void>,
): Promise<void> {
  const delegated = new FormData();
  delegated.set("id", String(target.id));
  await action(delegated);
}

function candidatePayload(value: unknown): Record<string, unknown> {
  const outer = recordValue(value);
  return "item" in outer ? recordValue(outer.item) : outer;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function machineEffect(value: unknown): string {
  return value === "boost" || value === "deprioritize" || value === "block" ? value : "";
}

function structuredCondition(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
}

function formValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function revalidateConsumerMemory(): void {
  revalidatePath("/about-you");
  revalidatePath("/", "layout");
}
