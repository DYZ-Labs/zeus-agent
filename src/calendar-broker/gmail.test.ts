import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { GMAIL_READ_SCOPE, GMAIL_WRITE_SCOPE, createGoogleGmailMcpServer } from "./gmail";
import type { CalendarBrokerStore, GmailGrant } from "./store";

const GRANT: GmailGrant = {
  id: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  refreshToken: "refresh",
  scopes: [GMAIL_WRITE_SCOPE],
  status: "active",
};

const OAUTH = { clientId: "id", clientSecret: "secret", redirectUri: "https://z/oauth" };

type Call = { url: string; method: string; body: unknown };

/**
 * A Gmail that answers from a table, and records every request.
 *
 * The point of these tests is the bytes Zeus's broker puts on the wire — the header block, the
 * encoding, what is asked for before a draft is created — so the fake answers plausibly and
 * the assertions are all about what it was asked.
 */
function fakeGmail(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "at", scope: GMAIL_WRITE_SCOPE });
    }
    for (const [fragment, answer] of Object.entries(overrides)) {
      if (url.includes(fragment)) return Response.json(answer);
    }
    if (url.includes("/profile")) return Response.json({ emailAddress: "me@acme.example" });
    if (url.includes("/drafts?") || url.endsWith("/drafts")) {
      return method === "POST"
        ? Response.json({ id: "draft-1", message: { id: "m1", threadId: "18f0a" } })
        : Response.json({});
    }
    if (url.includes("/trash")) {
      return Response.json({
        id: "18f0a",
        messages: [{ labelIds: ["TRASH"] }, { labelIds: ["TRASH"] }],
      });
    }
    if (url.includes("/threads/")) {
      return Response.json({
        messages: [
          {
            payload: {
              headers: [
                { name: "Message-ID", value: "<parent@acme.example>" },
                { name: "References", value: "<older@acme.example>" },
              ],
            },
          },
        ],
      });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

async function connect(
  fetcher: typeof fetch,
  options: { scopes?: string[]; requestKey?: string | null } = {},
) {
  const server = createGoogleGmailMcpServer({
    grant: { ...GRANT, scopes: options.scopes ?? [GMAIL_WRITE_SCOPE] },
    store: {} as CalendarBrokerStore,
    oauth: OAUTH,
    requestKey: options.requestKey === undefined ? "request-key" : options.requestKey,
    fetcher,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function draftedMessage(calls: Call[]): string {
  const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/drafts"));
  const raw = (post?.body as { message?: { raw?: string } })?.message?.raw ?? "";
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("what the broker offers", () => {
  it("shows a read-only grant no way to write", async () => {
    // The scope decides here as well as at the callback and at capability binding. A tool
    // that is not registered is one no argument can reach.
    const { fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher, { scopes: [GMAIL_READ_SCOPE] });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["get_thread", "search_threads"]);
    await close();
  });

  it("offers drafting, trashing, and restoring to a write grant, and never sending", async () => {
    const { fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_draft",
      "get_thread",
      "search_threads",
      "trash_thread",
      "untrash_thread",
    ]);
    expect(tools.find((tool) => /send/u.test(tool.name))).toBeUndefined();
    expect(tools.find((tool) => tool.name === "trash_thread")?.annotations?.destructiveHint)
      .toBe(true);
    expect(tools.find((tool) => tool.name === "create_draft")?.annotations?.destructiveHint)
      .toBe(false);
    await close();
  });
});

describe("saving a draft", () => {
  it("builds a reply Gmail will file in the right conversation", async () => {
    const { calls, fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher);
    await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["sarah@acme.example"],
        subject: "Re: Q3 planning",
        body: "Tuesday is out for me.",
        threadId: "18f0a",
      },
    });

    const message = draftedMessage(calls);
    expect(message).toContain("To: sarah@acme.example");
    expect(message).toContain("Subject: Re: Q3 planning");
    expect(message).toContain("In-Reply-To: <parent@acme.example>");
    // The parent's own references come first, then the parent — which is what makes a reply
    // land in the thread rather than beside it.
    expect(message).toContain("References: <older@acme.example> <parent@acme.example>");
    expect(Buffer.from("Tuesday is out for me.", "utf8").toString("base64")).toBeTruthy();
    expect(message).toContain(
      Buffer.from("Tuesday is out for me.", "utf8").toString("base64"),
    );
    const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/drafts"));
    expect((post?.body as { message: { threadId: string } }).message.threadId).toBe("18f0a");
    await close();
  });

  it("cannot be talked into extra headers by a subject", async () => {
    // A subject carrying a line break would forge whatever header came after it — Bcc being
    // the obvious one. The schema makes that unrepresentable rather than stripping it.
    const { calls, fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher);
    const result = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["sarah@acme.example"],
        subject: "Hello\r\nBcc: attacker@evil.example",
        body: "hi",
      },
    });
    expect(result.isError).toBe(true);
    expect(calls.filter((call) => call.method === "POST" && call.url.includes("gmail.googleapis.com"))).toHaveLength(0);
    await close();
  });

  it("refuses a recipient that is not a bare address", async () => {
    const { calls, fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher);
    for (const to of [["Sarah Chen <sarah@acme.example>"], ["sarah@acme.example, x@y.example"]]) {
      const result = await client.callTool({ name: "create_draft", arguments: { to, subject: "s", body: "b" } });
      expect(result.isError).toBe(true);
    }
    expect(calls.filter((call) => call.method === "POST" && call.url.includes("gmail.googleapis.com"))).toHaveLength(0);
    await close();
  });

  it("encodes a subject that ASCII cannot carry", async () => {
    const { calls, fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher);
    await client.callTool({
      name: "create_draft",
      arguments: { to: ["sarah@acme.example"], subject: "Café plans", body: "hi" },
    });
    expect(draftedMessage(calls)).toContain("Subject: =?UTF-8?B?");
    await close();
  });

  it("creates nothing twice for one request key", async () => {
    // The derived Message-ID is `create_event`'s derived event id in the only form this API
    // allows, and looking it up first is what turns a retry into a no-op.
    const { calls, fetcher } = fakeGmail({
      "/drafts?": { drafts: [{ id: "draft-1", message: { threadId: "18f0a" } }] },
    });
    const { client, close } = await connect(fetcher);
    const result = await client.callTool({
      name: "create_draft",
      arguments: { to: ["sarah@acme.example"], subject: "s", body: "b" },
    });
    expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/drafts")))
      .toHaveLength(0);
    expect(JSON.stringify(result.content)).toContain("draft-1");
    await close();
  });

  it("will not draft without a durable request key", async () => {
    const { calls, fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher, { requestKey: null });
    const result = await client.callTool({
      name: "create_draft",
      arguments: { to: ["sarah@acme.example"], subject: "s", body: "b" },
    });
    expect(result.isError).toBe(true);
    expect(calls.filter((call) => call.method === "POST" && call.url.includes("gmail.googleapis.com"))).toHaveLength(0);
    await close();
  });
});

describe("moving a thread to Trash", () => {
  it("trashes the whole thread and reads the outcome back off the answer", async () => {
    const { calls, fetcher } = fakeGmail();
    const { client, close } = await connect(fetcher);
    const result = await client.callTool({
      name: "trash_thread",
      arguments: { threadId: "18f0a" },
    });
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/threads/18f0a/trash")))
      .toBe(true);
    expect(JSON.parse(String((result.content as { text: string }[])[0]?.text))).toEqual({
      id: "18f0a",
      trashed: true,
      message_count: 2,
    });
    await close();
  });

  it("does not claim a thread was trashed when Gmail did not say so", async () => {
    const { fetcher } = fakeGmail({
      "/trash": { id: "18f0a", messages: [{ labelIds: ["INBOX"] }] },
    });
    const { client, close } = await connect(fetcher);
    const result = await client.callTool({
      name: "trash_thread",
      arguments: { threadId: "18f0a" },
    });
    expect(String((result.content as { text: string }[])[0]?.text)).toContain('"trashed":false');
    await close();
  });

  it("takes a thread back out again, and says it is no longer trashed", async () => {
    const { calls, fetcher } = fakeGmail({
      "/untrash": { id: "18f0a", messages: [{ labelIds: ["INBOX"] }, { labelIds: ["INBOX"] }] },
    });
    const { client, close } = await connect(fetcher);
    const result = await client.callTool({
      name: "untrash_thread",
      arguments: { threadId: "18f0a" },
    });
    expect(calls.some((call) => call.url.endsWith("/threads/18f0a/untrash"))).toBe(true);
    expect(JSON.parse(String((result.content as { text: string }[])[0]?.text))).toEqual({
      id: "18f0a",
      trashed: false,
      message_count: 2,
    });
    await close();
  });

  it("does not claim a restore worked while the thread is still in Trash", async () => {
    const { fetcher } = fakeGmail({
      "/untrash": { id: "18f0a", messages: [{ labelIds: ["TRASH"] }] },
    });
    const { client, close } = await connect(fetcher);
    const result = await client.callTool({
      name: "untrash_thread",
      arguments: { threadId: "18f0a" },
    });
    expect(String((result.content as { text: string }[])[0]?.text)).toContain('"trashed":true');
    await close();
  });

  it("names a refusal so the connection page can tell whose problem it is", async () => {
    const fetcher = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "at" });
      }
      return Response.json(
        { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
        { status: 403 },
      );
    }) as unknown as typeof fetch;
    const { client, close } = await connect(fetcher);
    const result = await client.callTool({
      name: "trash_thread",
      arguments: { threadId: "18f0a" },
    });
    expect(result.isError).toBe(true);
    expect(String((result.content as { text: string }[])[0]?.text)).toContain(
      "gmail_http_403_access_token_scope_insufficient",
    );
    await close();
  });
});
