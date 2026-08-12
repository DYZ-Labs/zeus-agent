import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConversation: vi.fn(),
  getExperienceSettings: vi.fn(),
  getOwnerAccess: vi.fn(),
  hasCredentials: vi.fn(),
  hydrateConversationTurns: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/components/chat", () => ({
  Chat: function MockChat() {
    return null;
  },
}));
vi.mock("@/core/chat-hydration", () => ({
  hydrateConversationTurns: mocks.hydrateConversationTurns,
}));
vi.mock("@/core/conversations", () => ({
  getConversation: mocks.getConversation,
}));
vi.mock("@/core/experience", () => ({
  getExperienceSettings: mocks.getExperienceSettings,
}));
vi.mock("@/core/openai", () => ({ hasCredentials: mocks.hasCredentials }));
vi.mock("@/server/auth/access", () => ({ getOwnerAccess: mocks.getOwnerAccess }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import ChatPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasCredentials.mockReturnValue(true);
  mocks.getExperienceSettings.mockReturnValue({ onboardingStatus: "complete" });
});

describe("chat page access modes", () => {
  it("renders signed-out visitors as guests without reading a requested private conversation", async () => {
    mocks.getOwnerAccess.mockResolvedValue(deniedAccess("signed_out"));

    const props = await renderPage({
      conversation: "conversation_c",
      prompt: "Help me think",
    });

    expect(props).toMatchObject({
      accessMode: "guest",
      showAuthActions: true,
      initialPrompt: "Help me think",
      initialTurns: [],
    });
    expect(props.initialConversationId).toBeUndefined();
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.hydrateConversationTurns).not.toHaveBeenCalled();
    expect(mocks.getExperienceSettings).not.toHaveBeenCalled();
  });

  it("keeps intentional local mode durable and hydrates its requested conversation", async () => {
    const db = { name: "local-test-db" };
    const conversation = { id: 12 };
    const turns = [{ id: "message_1", role: "user", text: "Saved turn" }];
    mocks.getOwnerAccess.mockResolvedValue({
      state: "local",
      canAccessPrivateData: true,
      account: null,
      db,
      message: null,
    });
    mocks.getConversation.mockReturnValue(conversation);
    mocks.hydrateConversationTurns.mockReturnValue(turns);

    const props = await renderPage({ conversation: "conversation_c" });

    expect(props).toMatchObject({
      accessMode: "durable",
      initialConversationId: "conversation_c",
      initialTurns: turns,
    });
    expect(mocks.getConversation).toHaveBeenCalledWith(db, 12);
    expect(mocks.hydrateConversationTurns).toHaveBeenCalledWith(db, 12, 400);
    expect(mocks.getExperienceSettings).toHaveBeenCalledWith(db);
  });

  it.each([
    "wrong_account",
    "forbidden_origin",
    "misconfigured",
    "unavailable",
  ] as const)("keeps %s access blocked and exposes the login gate", async (state) => {
    mocks.getOwnerAccess.mockResolvedValue(deniedAccess(state));

    const props = await renderPage({ conversation: "conversation_c" });

    expect(props).toMatchObject({
      accessMode: "blocked",
      showAuthActions: true,
      initialTurns: [],
    });
    expect(props.initialConversationId).toBeUndefined();
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.hydrateConversationTurns).not.toHaveBeenCalled();
    expect(mocks.getExperienceSettings).not.toHaveBeenCalled();
  });
});

async function renderPage(searchParams: {
  prompt?: string;
  conversation?: string;
}): Promise<Record<string, unknown>> {
  const element = await ChatPage({ searchParams: Promise.resolve(searchParams) });
  return (element as ReactElement<Record<string, unknown>>).props;
}

function deniedAccess(
  state: "signed_out" | "wrong_account" | "forbidden_origin" | "misconfigured" | "unavailable",
) {
  return {
    state,
    canAccessPrivateData: false,
    account: null,
    db: null,
    message: "Private memory stayed locked.",
  };
}
