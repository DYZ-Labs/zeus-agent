/**
 * @vitest-environment jsdom
 */

import "@/test/setup";

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Chat } from "./chat";
import { NEW_CHAT_EVENT } from "./chat-events";

vi.mock("@/app/experience-actions", () => ({
  setOnboardingStatusAction: vi.fn().mockResolvedValue(undefined),
}));

const PRIVACY_NOTE = "This chat isn’t saved. Context lasts until you refresh or leave.";

describe("Chat guest experience", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => streamedChatResponse(`Reply ${fetchMock.mock.calls.length}`));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("shows signed-out visitors the standard new-chat interface without memory affordances", () => {
    renderGuest({
      initialTurns: [
        { id: "message:91", role: "user", text: "A saved private message" },
        {
          id: "message:92",
          role: "assistant",
          text: "A saved private reply",
          responseId: "response:92",
          recalled: 2,
        },
      ],
      initialConversationId: "conversation:9",
    });

    expect(screen.getByRole("heading", { name: "What can I help with?" })).toBeInTheDocument();
    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Help me think through something" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft something with me" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain something clearly" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Zeus" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign up" })).toBeInTheDocument();

    expect(screen.queryByText("Log in to chat")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Temporary chats are available after login and are never saved."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Temporary chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Temporary chat/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing from this chat is saved/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No saved memory is read/i)).not.toBeInTheDocument();
    expect(screen.queryByText("A saved private message")).not.toBeInTheDocument();
    expect(screen.queryByText("A saved private reply")).not.toBeInTheDocument();
    expect(screen.queryByText(/remembered detail/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Why Zeus said this" })).not.toBeInTheDocument();
  });

  it("keeps bounded context for later guest turns and clears it on new-chat and remount", async () => {
    const user = userEvent.setup();
    let view = renderGuest();

    await sendMessage(user, "First question", "Reply 1");
    await sendMessage(user, "Second question", "Reply 2");

    expect(requestBody(0)).toMatchObject({
      input: "First question",
      mode: "temporary",
      temporaryHistory: [],
    });
    expect(requestBody(1)).toMatchObject({
      input: "Second question",
      mode: "temporary",
      temporaryHistory: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "Reply 1" },
      ],
    });
    expect(screen.queryByText(/Used 2 remembered details/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Why Zeus said this" })).not.toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(NEW_CHAT_EVENT)));
    await waitFor(() => {
      expect(screen.queryByText("First question")).not.toBeInTheDocument();
      expect(screen.queryByText("Second question")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "What can I help with?" })).toBeInTheDocument();
    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();

    await sendMessage(user, "After new chat", "Reply 3");
    expect(requestBody(2).temporaryHistory).toEqual([]);

    view.unmount();
    view = renderGuest();
    expect(screen.queryByText("After new chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Reply 3")).not.toBeInTheDocument();

    await sendMessage(user, "After remount", "Reply 4");
    expect(requestBody(3).temporaryHistory).toEqual([]);
    view.unmount();
  });

  function requestBody(index: number): Record<string, unknown> {
    const call = fetchMock.mock.calls[index];
    expect(call).toBeDefined();
    const init = call?.[1];
    expect(typeof init?.body).toBe("string");
    return JSON.parse(init?.body as string) as Record<string, unknown>;
  }
});

describe("Chat durable experience", () => {
  it("keeps the explicit signed-in temporary-chat controls", async () => {
    const user = userEvent.setup();
    render(
      <Chat
        hasCredentials
        accessMode="durable"
        showAuthActions={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "What can I help with?" })).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Temporary chat" });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(screen.getByRole("heading", { name: "Temporary chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Temporary chat on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Nothing from this chat is saved")).toBeInTheDocument();
    expect(screen.getByText(/No saved memory is read/i)).toBeInTheDocument();
    expect(screen.queryByText(PRIVACY_NOTE)).not.toBeInTheDocument();
  });
});

describe("Chat blocked experience", () => {
  it("does not show the login-required chat notice", () => {
    render(
      <Chat
        hasCredentials
        accessMode="blocked"
        showAuthActions
      />,
    );

    expect(screen.queryByText("Log in to chat")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Temporary chats are available after login and are never saved."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Zeus" })).toBeDisabled();
  });
});

function renderGuest(overrides: Partial<ComponentProps<typeof Chat>> = {}) {
  return render(
    <Chat
      hasCredentials
      accessMode="guest"
      showAuthActions
      {...overrides}
    />,
  );
}

async function sendMessage(
  user: ReturnType<typeof userEvent.setup>,
  input: string,
  expectedReply: string,
): Promise<void> {
  const composer = screen.getByRole("textbox", { name: "Message Zeus" });
  await user.type(composer, input);
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText(expectedReply)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument());
}

function streamedChatResponse(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text_delta", text }),
      JSON.stringify({
        type: "response_complete",
        responseId: "response:999",
        memoryJobId: null,
        recalled: 2,
        memoryError: null,
      }),
      "",
    ].join("\n"),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}
