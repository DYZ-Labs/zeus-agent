import type { Db } from "./db";
import { now } from "./db";
import type {
  ExperienceSettings,
  OnboardingStatus,
  RememberingMode,
  SuggestionMode,
} from "./contracts";
import { getStewardshipSetting, setStewardshipMode } from "./stewardship";
import type { StewardshipMode } from "./schema";

type ExperienceSettingRow = {
  remembering_mode: RememberingMode;
  onboarding_status: OnboardingStatus;
  labs_enabled: 0 | 1;
};

export function getExperienceSettings(db: Db): ExperienceSettings {
  const row = db
    .prepare<[], ExperienceSettingRow>(
      `SELECT remembering_mode, onboarding_status, labs_enabled
       FROM experience_setting WHERE id = 1`,
    )
    .get();
  if (!row) throw new Error("Experience settings are missing");
  return {
    rememberingMode: row.remembering_mode,
    suggestionMode: suggestionModeForStewardship(getStewardshipSetting(db).mode),
    onboardingStatus: row.onboarding_status,
    labsEnabled: row.labs_enabled === 1,
  };
}

export function setRememberingMode(db: Db, mode: RememberingMode): ExperienceSettings {
  db.prepare<[RememberingMode, string]>(
    `UPDATE experience_setting
     SET remembering_mode = ?, updated_at = ? WHERE id = 1`,
  ).run(mode, now());
  return getExperienceSettings(db);
}

export function setOnboardingStatus(db: Db, status: OnboardingStatus): ExperienceSettings {
  const current = getExperienceSettings(db).onboardingStatus;
  if (onboardingRank(status) <= onboardingRank(current)) {
    return getExperienceSettings(db);
  }
  db.prepare<[OnboardingStatus, string]>(
    `UPDATE experience_setting
     SET onboarding_status = ?, updated_at = ? WHERE id = 1`,
  ).run(status, now());
  return getExperienceSettings(db);
}

function onboardingRank(status: OnboardingStatus): number {
  return status === "welcome" ? 0 : status === "first_chat" ? 1 : 2;
}

export function setLabsEnabled(db: Db, enabled: boolean): ExperienceSettings {
  db.prepare<[number, string]>(
    `UPDATE experience_setting
     SET labs_enabled = ?, updated_at = ? WHERE id = 1`,
  ).run(enabled ? 1 : 0, now());
  return getExperienceSettings(db);
}

export function setSuggestionMode(
  db: Db,
  mode: SuggestionMode,
  sourceMessageId: number | null = null,
): ExperienceSettings {
  setStewardshipMode(db, stewardshipModeForSuggestion(mode), sourceMessageId);
  return getExperienceSettings(db);
}

export function stewardshipModeForSuggestion(mode: SuggestionMode): StewardshipMode {
  return mode === "important"
    ? "quiet"
    : mode === "helpful"
      ? "balanced"
      : mode;
}

export function suggestionModeForStewardship(mode: StewardshipMode): SuggestionMode {
  return mode === "quiet" ? "important" : mode === "balanced" ? "helpful" : mode;
}
