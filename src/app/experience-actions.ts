"use server";

import { revalidatePath } from "next/cache";

import {
  setLabsEnabled,
  setOnboardingStatus,
  setRememberingMode,
  setSuggestionMode,
} from "@/core/experience";
import {
  OnboardingStatus,
  RememberingMode,
  SuggestionMode,
} from "@/core/contracts";
import { requireOwnerDb } from "@/server/auth/access";

export async function setRememberingModeAction(formData: FormData): Promise<void> {
  const parsed = RememberingMode.safeParse(formData.get("mode"));
  if (!parsed.success) return;
  setRememberingMode(await requireOwnerDb(), parsed.data);
  revalidatePath("/settings");
}

export async function setSuggestionModeAction(formData: FormData): Promise<void> {
  const parsed = SuggestionMode.safeParse(formData.get("mode"));
  if (!parsed.success) return;
  setSuggestionMode(await requireOwnerDb(), parsed.data);
  revalidatePath("/settings");
  revalidatePath("/today");
}

export async function setLabsEnabledAction(formData: FormData): Promise<void> {
  setLabsEnabled(await requireOwnerDb(), formData.get("enabled") === "true");
  revalidatePath("/settings");
  revalidatePath("/today");
}

export async function setOnboardingStatusAction(formData: FormData): Promise<void> {
  const parsed = OnboardingStatus.safeParse(formData.get("status"));
  if (!parsed.success) return;
  setOnboardingStatus(await requireOwnerDb(), parsed.data);
  revalidatePath("/");
  revalidatePath("/settings");
}
