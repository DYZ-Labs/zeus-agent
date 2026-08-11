import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCandidate, getCandidate, listCandidates } from "@/core/candidates";
import {
  appendMessage,
  createConversation,
  getConversation,
  listChatHistory,
  listConversations,
  messagesIn,
} from "@/core/conversations";
import { openTestDb } from "@/core/db";
import { listFacets, recordFacet } from "@/core/facets";
import { ensureEvidencePassage } from "@/core/passages";

const actionMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  embedFact: vi.fn(async () => true),
  embedFacet: vi.fn(async () => true),
  embedPassage: vi.fn(async () => true),
}));

vi.mock("@/server/db", () => ({ getDb: actionMocks.getDb }));
vi.mock("next/cache", () => ({ revalidatePath: actionMocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: actionMocks.redirect }));
vi.mock("@/core/embed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/embed")>();
  return {
    ...actual,
    embedFact: actionMocks.embedFact,
    embedFacet: actionMocks.embedFacet,
    embedPassage: actionMocks.embedPassage,
  };
});

import {
  acceptFacetCandidateAction,
  answerReflectionAction,
  deleteAllRecentChatsAction,
  deleteConversationFromHistoryAction,
} from "./actions";

describe("understanding web-action embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("embeds a facet and its exact passage only after edited acceptance", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I prefer written decisions.");
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "pending",
    });
    const candidate = createCandidate(db, {
      kind: "facet",
      payload: {
        item: facetItem(source.id, source.content),
        entities: [],
      },
      reason: "inference",
      confidence: 0.75,
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });
    actionMocks.embedFacet.mockImplementationOnce(async () => {
      expect(getCandidate(db, candidate.id)?.status).toBe("accepted");
      return true;
    });
    actionMocks.embedPassage.mockImplementationOnce(async () => {
      expect(
        db.prepare<[number], { recall_status: string }>(
          "SELECT recall_status FROM evidence_passage WHERE id = ?",
        ).get(passage.id)?.recall_status,
      ).toBe("allowed");
      return true;
    });

    const form = new FormData();
    form.set("id", String(candidate.id));
    form.set("statement", "Give me important decisions in writing.");
    form.set("machineEffect", "boost");
    await acceptFacetCandidateAction(form);

    const accepted = listFacets(db)[0]!;
    expect(actionMocks.embedFacet).toHaveBeenCalledWith(
      db,
      accepted.id,
      "communication style Give me important decisions in writing.",
    );
    expect(actionMocks.embedPassage).toHaveBeenCalledWith(db, passage.id, passage.text);
  });

  it("does not embed an ambiguous reflection that remains pending", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const form = new FormData();
    form.set("prompt", "What principle should Zeus protect?");
    form.set("kind", "value");
    form.set("answer", "not sure");

    await answerReflectionAction(form);

    expect(listFacets(db)).toEqual([]);
    expect(listCandidates(db, { kind: "facet" })).toHaveLength(1);
    expect(actionMocks.embedFacet).not.toHaveBeenCalled();
    expect(actionMocks.embedPassage).not.toHaveBeenCalled();
  });

  it("embeds a direct accepted reflection and its allowed passage", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const form = new FormData();
    form.set("prompt", "What principle should Zeus protect?");
    form.set("kind", "value");
    form.set("answer", "Protect time with my family when good options compete.");

    await answerReflectionAction(form);

    const accepted = listFacets(db)[0]!;
    expect(actionMocks.embedFacet).toHaveBeenCalledWith(
      db,
      accepted.id,
      "value Protect time with my family when good options compete.",
    );
    expect(actionMocks.embedPassage).toHaveBeenCalledTimes(1);
  });
});

describe("conversation deletion actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides every recent chat without deleting stored conversations", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const first = createConversation(db, { title: "First chat" });
    const second = createConversation(db, { title: "Second chat" });
    appendMessage(db, first.id, "user", "Keep this first transcript.");
    appendMessage(db, second.id, "user", "Keep this second transcript.");

    const form = new FormData();
    form.set("confirmation", "delete-all-recent");
    await deleteAllRecentChatsAction(form);

    expect(listChatHistory(db)).toEqual([]);
    expect(listConversations(db)).toHaveLength(2);
    expect(messagesIn(db, first.id)).toHaveLength(1);
    expect(messagesIn(db, second.id)).toHaveLength(1);
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith("/settings");
    expect(actionMocks.redirect).not.toHaveBeenCalled();
  });

  it("hides only the selected recent chat while preserving its details and transcript", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const deleted = createConversation(db, { title: "Delete me" });
    const preserved = createConversation(db, { title: "Keep me" });
    const source = appendMessage(db, deleted.id, "user", "I value careful decisions.");
    appendMessage(db, preserved.id, "user", "Keep this chat visible.");
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    recordFacet(db, {
      kind: "value",
      statement: "The user values careful decisions",
      sourceMessageId: source.id,
      passageIds: [passage.id],
      confidence: 0.95,
    });

    await deleteConversationFromHistoryAction(deleted.id, "delete");

    expect(getConversation(db, deleted.id)).not.toBeNull();
    expect(getConversation(db, preserved.id)).not.toBeNull();
    expect(listChatHistory(db).map((chat) => chat.id)).toEqual([preserved.id]);
    expect(messagesIn(db, deleted.id)).toHaveLength(1);
    expect(listFacets(db)).toHaveLength(1);
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

function facetItem(sourceMessageId: number, quote: string) {
  return {
    kind: "communication_style" as const,
    statement: "I prefer written decisions.",
    scope: { kind: "global" as const },
    condition: null,
    importance: "normal" as const,
    machine_effect: null,
    confidence: 0.75,
    effective_from: null,
    evidence: [{ source_message_id: sourceMessageId, quote }],
    grounding: "user_statement" as const,
    explicitness: "inferred" as const,
    sensitivity: "normal" as const,
    ambiguity: "clear" as const,
  };
}
