import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCandidate, getCandidate, listCandidates } from "@/core/candidates";
import { getConnectorByPresetId, toolSchemaHash } from "@/core/connectors";
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
  probeConnectorPreset: vi.fn(),
}));

vi.mock("@/server/db", () => ({ getDb: actionMocks.getDb }));
vi.mock("server-only", () => ({}));
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
vi.mock("@/core/mcp-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/mcp-client")>();
  return {
    ...actual,
    probeConnectorPreset: actionMocks.probeConnectorPreset,
  };
});

import {
  acceptFacetCandidateAction,
  answerReflectionAction,
  clearConversationHistoryAction,
  configureConnectorPresetAction,
  deleteConversationFromHistoryAction,
  removeConversationFromHistoryAction,
} from "./actions";
import { ConnectorError } from "@/core/mcp-client";

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

  it("clears every chat from visible history without erasing source messages", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const first = createConversation(db, { title: "First chat" });
    const second = createConversation(db, { title: "Second chat" });
    appendMessage(db, first.id, "user", "Keep this first transcript.");
    appendMessage(db, second.id, "user", "Keep this second transcript.");

    await clearConversationHistoryAction();

    expect(listChatHistory(db)).toEqual([]);
    expect(listConversations(db)).toHaveLength(2);
    expect(messagesIn(db, first.id)).toHaveLength(1);
    expect(messagesIn(db, second.id)).toHaveLength(1);
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith("/settings");
    expect(actionMocks.redirect).not.toHaveBeenCalled();
  });

  it("removes a recent chat immediately without erasing its source", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const removed = createConversation(db, { title: "Remove me" });
    const preserved = createConversation(db, { title: "Keep me" });
    appendMessage(db, removed.id, "user", "Keep this source message.");
    appendMessage(db, preserved.id, "user", "Keep this chat visible.");

    await removeConversationFromHistoryAction(removed.id);

    expect(listChatHistory(db).map((chat) => chat.id)).toEqual([preserved.id]);
    expect(getConversation(db, removed.id)).not.toBeNull();
    expect(messagesIn(db, removed.id)).toHaveLength(1);
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("permanently erases only the selected source and its solely evidenced details", async () => {
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

    await deleteConversationFromHistoryAction(deleted.id, "erase-source");

    expect(getConversation(db, deleted.id)).toBeNull();
    expect(getConversation(db, preserved.id)).not.toBeNull();
    expect(listChatHistory(db).map((chat) => chat.id)).toEqual([preserved.id]);
    expect(messagesIn(db, deleted.id)).toHaveLength(0);
    expect(listFacets(db)).toHaveLength(0);
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

describe("guided connector actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  });

  it("commits one read-only connection and its source after a successful probe", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    actionMocks.probeConnectorPreset.mockResolvedValue({ tools: calendarTools() });

    const state = await configureConnectorPresetAction(idleConnectorState(), setupForm([
      "calendar.list_events",
    ]));

    expect(state).toMatchObject({ status: "success", code: "connected" });
    const connector = getConnectorByPresetId(db, "google-calendar-official");
    expect(connector).not.toBeNull();
    expect(connector?.capabilities).toMatchObject([
      { slot: "calendar.list_events", enabled: 1 },
    ]);
    const sources = messagesIn(
      db,
      listConversations(db).find((conversation) => conversation.title === "Memory curation")!.id,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]?.role).toBe("user");
    expect(connector?.source_message_id).toBe(sources[0]?.id);
  });

  it("leaves no rows or provenance when the provider probe fails", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    actionMocks.probeConnectorPreset.mockRejectedValue(
      new ConnectorError("adc_missing", "raw provider detail must not escape"),
    );

    const state = await configureConnectorPresetAction(idleConnectorState(), setupForm([
      "calendar.list_events",
    ]));

    expect(state).toEqual({
      status: "error",
      code: "adc_missing",
      message: "Create Application Default Credentials with the generated Calendar scopes.",
    });
    expect(getConnectorByPresetId(db, "google-calendar-official")).toBeNull();
    expect(listConversations(db)).toEqual([]);
  });

  it("updates the full selected permission set with one additional source", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    actionMocks.probeConnectorPreset.mockResolvedValue({ tools: calendarTools() });
    await configureConnectorPresetAction(idleConnectorState(), setupForm([
      "calendar.list_events",
    ]));
    const original = getConnectorByPresetId(db, "google-calendar-official")!;

    const state = await configureConnectorPresetAction(
      idleConnectorState(),
      setupForm(
        ["calendar.create_event", "calendar.update_event"],
        original.id,
      ),
    );

    expect(state).toMatchObject({ status: "success", code: "updated" });
    const updated = getConnectorByPresetId(db, "google-calendar-official")!;
    const bySlot = new Map(updated.capabilities.map((capability) => [capability.slot, capability]));
    expect(bySlot.get("calendar.list_events")?.enabled).toBe(0);
    expect(bySlot.get("calendar.create_event")?.enabled).toBe(1);
    expect(bySlot.get("calendar.update_event")?.enabled).toBe(1);
    const curation = listConversations(db).find(
      (conversation) => conversation.title === "Memory curation",
    );
    expect(messagesIn(db, curation!.id)).toHaveLength(2);
    expect(actionMocks.probeConnectorPreset).toHaveBeenLastCalledWith(
      "google-calendar-official",
      ["calendar.create_event", "calendar.update_event"],
      { tokenFailureCode: "scope_missing" },
    );
  });

  it("rejects a forged preset before probing", async () => {
    const db = openTestDb();
    actionMocks.getDb.mockReturnValue(db);
    const form = setupForm(["calendar.list_events"]);
    form.set("presetId", "attacker-controlled");

    const state = await configureConnectorPresetAction(idleConnectorState(), form);

    expect(state.code).toBe("invalid_preset");
    expect(actionMocks.probeConnectorPreset).not.toHaveBeenCalled();
    expect(getConnectorByPresetId(db, "google-calendar-official")).toBeNull();
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

function idleConnectorState() {
  return { status: "idle", code: "idle", message: "" } as const;
}

function setupForm(slots: readonly string[], connectorId?: number): FormData {
  const form = new FormData();
  form.set("presetId", "google-calendar-official");
  if (connectorId !== undefined) form.set("connectorId", String(connectorId));
  for (const slot of slots) form.append("slots", slot);
  return form;
}

function calendarTools() {
  return [
    calendarTool("list_events", { type: "object", properties: { timeMin: { type: "string" } } }),
    calendarTool("create_event", { type: "object", properties: { summary: { type: "string" } } }),
    calendarTool("update_event", { type: "object", properties: { eventId: { type: "string" } } }),
  ];
}

function calendarTool(name: string, inputSchema: unknown) {
  return {
    name,
    description: null,
    inputSchema,
    schemaHash: toolSchemaHash(inputSchema),
    readOnlyHint: name === "list_events",
  };
}
