import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { appendMessage, createConversation } from "./conversations";
import { migrate, openTestDb } from "./db";
import { MIGRATIONS } from "./migrations";
import {
  getExperienceSettings,
  setLabsEnabled,
  setOnboardingStatus,
  setRememberingMode,
  setSuggestionMode,
} from "./experience";

describe("consumer experience settings", () => {
  it("starts with safe consumer defaults and persists each public mode", () => {
    const db = openTestDb();
    expect(getExperienceSettings(db)).toEqual({
      rememberingMode: "automatic",
      suggestionMode: "helpful",
      onboardingStatus: "welcome",
      labsEnabled: false,
    });

    setRememberingMode(db, "confirm");
    setSuggestionMode(db, "important");
    setOnboardingStatus(db, "first_chat");
    setLabsEnabled(db, true);

    expect(getExperienceSettings(db)).toEqual({
      rememberingMode: "confirm",
      suggestionMode: "important",
      onboardingStatus: "first_chat",
      labsEnabled: true,
    });
  });

  it("permanently marks chats created with remembering off as ineligible for recall", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const message = appendMessage(db, conversation.id, "user", "Do not recall this later", {
      recallState: "blocked",
      crossChatRecallEligible: false,
    });

    expect(message).toMatchObject({
      recall_state: "blocked",
      cross_chat_recall_eligible: 0,
    });
    expect(
      db.prepare<[number], { eligible: number }>(
        "SELECT cross_chat_recall_eligible AS eligible FROM message WHERE id = ?",
      ).get(message.id),
    ).toEqual({ eligible: 0 });
  });

  it("does not show first-run guidance to an established store after migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 20));
    const conversation = createConversation(db);
    appendMessage(db, conversation.id, "user", "An existing conversation");

    migrate(db);

    expect(getExperienceSettings(db).onboardingStatus).toBe("complete");
  });
});
