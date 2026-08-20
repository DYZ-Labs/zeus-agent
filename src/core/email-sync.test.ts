import { beforeEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import {
  cacheEmailThreads,
  cachedThreads,
  emailWindow,
  getThreadArguments,
  lastKnownThreads,
  parseEmailThreads,
  parseThreadMessages,
  provenWindow,
  readEmailCoverage,
  searchThreadArguments,
} from "./email-sync";

/**
 * Email is the most adversarial text Zeus will ever cache, and the least verifiable: unlike
 * a calendar there is no write gate to fail closed for, and unlike a calendar the server
 * will not say whether a read was complete. Most of these tests are about the two things
 * that follow — never sending an unbounded read, and never claiming a window was covered
 * when it was not.
 */

const NOW = new Date("2026-08-20T12:00:00.000Z");

let db: Db;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    query: { type: "string" },
    pageSize: { type: "integer" },
    pageToken: { type: "string" },
    view: { type: "string" },
    includeTrash: { type: "boolean" },
  },
});

function thread(id: string, date: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    messages: [
      {
        id: `${id}-m1`,
        subject: "Q3 planning",
        sender: "sarah@example.com",
        date,
        snippet: "Here is the deck you asked for, plus a few notes about",
        labelIds: ["INBOX"],
        ...overrides,
      },
    ],
  };
}

beforeEach(() => {
  db = openTestDb();
  const conversation = createConversation(db, { title: "Chat", source: "web" });
  const messageId = appendMessage(db, conversation.id, "user", "hello", {
    origin: "user_action",
    recallState: "blocked",
  }).id;
  db.exec(`
    INSERT INTO connector (id, label, transport, url, source_message_id, status, enabled,
                           created_at, updated_at)
    VALUES (1, 'Gmail', 'http', 'https://example.test/mcp', ${messageId}, 'ready', 1,
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
  `);
});

describe("what Zeus will ask the inbox for", () => {
  it("always bounds the search, and pins the view rather than trusting a default", () => {
    const args = searchThreadArguments(SCHEMA, 7);

    expect(args.query).toBe("in:inbox newer_than:7d");
    expect(args.pageSize).toBe(50);
    // `get_thread` defaults to full message bodies, and a default that changes is a default
    // that starts sending them. Pinned, not assumed.
    expect(args.view).toBe("THREAD_VIEW_MINIMAL");
  });

  it("refuses to search at all when it cannot express a bound", () => {
    // An unbounded search pulls an entire mailbox into a cache meant to hold a week. There
    // is no safe default for this one, so there is no fallback.
    const noQuery = JSON.stringify({ type: "object", properties: { pageSize: {} } });

    expect(() => searchThreadArguments(noQuery, 7)).toThrow(/bounded query/u);
    expect(() => searchThreadArguments("{oops", 7)).toThrow(/invalid input schema/u);
    expect(() => searchThreadArguments(JSON.stringify({ type: "object" }), 7)).toThrow(
      /no reviewable input fields/u,
    );
  });

  it("refuses a contract that requires a field Zeus does not understand", () => {
    const demanding = JSON.stringify({
      type: "object",
      properties: { query: {}, mailboxId: {} },
      required: ["query", "mailboxId"],
    });

    expect(() => searchThreadArguments(demanding, 7)).toThrow(/unsupported field mailboxId/u);
  });

  it("sends only the fields the reviewed contract actually offers", () => {
    const minimal = JSON.stringify({ type: "object", properties: { query: {} } });

    expect(searchThreadArguments(minimal, 7)).toEqual({ query: "in:inbox newer_than:7d" });
  });

  it("accepts the live Gmail MCP search_threads input schema", () => {
    const live = JSON.stringify({
      description: "Request message for SearchThreads RPC.",
      properties: {
        includeTrash: { type: "boolean" },
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
        query: { type: "string" },
        view: {
          enum: ["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_METADATA_ONLY", "THREAD_VIEW_MINIMAL"],
          type: "string",
        },
      },
      type: "object",
    });

    expect(searchThreadArguments(live, 7)).toEqual({
      query: "in:inbox newer_than:7d",
      pageSize: 50,
      view: "THREAD_VIEW_MINIMAL",
    });
  });
});

describe("what Zeus keeps from the answer", () => {
  it("keeps the subject and sender, and drops the snippet", () => {
    // No view returns a subject without a snippet, so the snippet arrives and stops here.
    // The standing block promises subjects and senders only; this is where that becomes true.
    const { threads } = parseEmailThreads({
      threads: [thread("t1", "2026-08-20T09:00:00.000Z")],
    });

    expect(threads[0]).toEqual({
      id: "t1",
      subject: "Q3 planning",
      from: "sarah@example.com",
      last_activity_at: "2026-08-20T09:00:00.000Z",
      unread: false,
    });
    expect(JSON.stringify(threads)).not.toContain("Here is the deck");
  });

  it("describes a thread by its newest message, not its first", () => {
    const { threads } = parseEmailThreads({
      threads: [
        {
          id: "t1",
          messages: [
            { subject: "Q3 planning", sender: "sarah@example.com", date: "2026-08-18T09:00:00.000Z" },
            { subject: "Re: Q3 planning", sender: "kev@example.com", date: "2026-08-20T09:00:00.000Z" },
          ],
        },
      ],
    });

    expect(threads[0]?.subject).toBe("Re: Q3 planning");
    expect(threads[0]?.last_activity_at).toBe("2026-08-20T09:00:00.000Z");
  });

  it("fails the whole read rather than reporting an unreadable answer as an empty inbox", () => {
    expect(() => parseEmailThreads({ not_threads: [] })).toThrow(/did not contain a thread list/u);
    expect(() => parseEmailThreads({ threads: [{ subject: "no id" }] })).toThrow(/without an id/u);
    expect(() => parseEmailThreads({ threads: ["nope"] })).toThrow(/invalid thread/u);
  });

  it("reads Google's SearchThreadsResponse, including a date that is only a day", () => {
    const { threads } = parseEmailThreads({
      threads: [
        {
          id: "18abc",
          messages: [
            {
              subject: "Q3 planning",
              sender: "sarah@example.com",
              date: "2026-08-20",
              labelIds: ["INBOX", "UNREAD"],
            },
          ],
        },
      ],
      resultCountEstimate: "1",
    });

    expect(threads[0]).toMatchObject({
      id: "18abc",
      subject: "Q3 planning",
      from: "sarah@example.com",
      last_activity_at: "2026-08-20",
      unread: true,
    });
  });

  it("treats a protobuf-empty SearchThreadsResponse as an empty inbox, not as no read", () => {
    // Empty repeated fields are omitted. That is a successful empty read.
    expect(parseEmailThreads({})).toEqual({ threads: [], truncated: false });
    expect(parseEmailThreads({ resultCountEstimate: "0" })).toEqual({
      threads: [],
      truncated: false,
    });
  });

  it("unwraps a nested SearchThreads envelope", () => {
    const { threads } = parseEmailThreads({
      searchThreadsResponse: { threads: [thread("t1", "2026-08-20T09:00:00.000Z")] },
    });

    expect(threads[0]?.id).toBe("t1");
  });

  it("notices when the server said there was more", () => {
    const complete = parseEmailThreads({ threads: [thread("t1", "2026-08-20T09:00:00.000Z")] });
    const partial = parseEmailThreads({
      threads: [thread("t1", "2026-08-20T09:00:00.000Z")],
      nextPageToken: "abc",
    });

    expect(complete.truncated).toBe(false);
    expect(partial.truncated).toBe(true);
    expect(
      parseEmailThreads({
        threads: [thread("t1", "2026-08-20T09:00:00.000Z")],
        next_page_token: "abc",
      }).truncated,
    ).toBe(true);
  });
});

describe("the window a read actually proved", () => {
  const requested = emailWindow(NOW, 7);

  it("is the requested one when nothing was withheld", () => {
    expect(provenWindow(requested, [], false)).toEqual(requested);
  });

  it("narrows to the oldest thread returned when the page was truncated", () => {
    // Threads come back newest first, so a full page still completely covers everything
    // newer than its oldest thread: nothing in that range could have been withheld without
    // displacing it. That range is what gets reconciled; older threads are untouched.
    const threads = [
      { id: "a", subject: null, from: null, last_activity_at: "2026-08-20T09:00:00.000Z", unread: false },
      { id: "b", subject: null, from: null, last_activity_at: "2026-08-19T09:00:00.000Z", unread: false },
    ];

    expect(provenWindow(requested, threads, true)).toEqual({
      from: "2026-08-19T09:00:00.000Z",
      to: requested.to,
    });
  });

  it("never widens past what was asked for", () => {
    const older = [
      { id: "a", subject: null, from: null, last_activity_at: "2020-01-01T00:00:00.000Z", unread: false },
    ];

    expect(provenWindow(requested, older, true).from).toBe(requested.from);
  });

  it("proves nothing at all when a truncated page carries no readable date", () => {
    const undated = [
      { id: "a", subject: null, from: null, last_activity_at: null, unread: false },
    ];

    const proven = provenWindow(requested, undated, true);
    expect(proven.from).toBe(proven.to);
  });
});

describe("the cache reflects the inbox, not the union of every read", () => {
  function cache(threads: unknown[], extra: Record<string, unknown> = {}, at: Date = NOW) {
    return cacheEmailThreads(db, 1, { threads, ...extra }, at);
  }

  it("drops a thread the inbox stopped returning", () => {
    cache([thread("a", "2026-08-20T09:00:00.000Z"), thread("b", "2026-08-19T09:00:00.000Z")]);
    expect(cachedThreads(db, NOW).map((t) => t.id).sort()).toEqual(["a", "b"]);

    // The user archived "b". The next read is the only evidence Zeus will ever get.
    cache([thread("a", "2026-08-20T09:00:00.000Z")]);

    expect(cachedThreads(db, NOW).map((t) => t.id)).toEqual(["a"]);
  });

  it("leaves threads older than the proven window alone when a page was truncated", () => {
    // This is the whole point of narrowing rather than failing: a busy week overflows one
    // page routinely, and a cache that reconciled the full requested window would delete
    // everything the page could not reach.
    cache([
      thread("recent", "2026-08-20T09:00:00.000Z"),
      thread("older", "2026-08-16T09:00:00.000Z"),
    ]);
    expect(cachedThreads(db, NOW)).toHaveLength(2);

    // A truncated page reaching only back to the 19th says nothing about the 16th.
    cache([thread("recent", "2026-08-20T09:00:00.000Z")], { nextPageToken: "more" });

    expect(cachedThreads(db, NOW).map((t) => t.id).sort()).toEqual(["older", "recent"]);
  });

  it("records the proven window, not the requested one", () => {
    cache([thread("recent", "2026-08-20T09:00:00.000Z")], { nextPageToken: "more" });

    const coverage = readEmailCoverage(db);
    expect(coverage?.from).toBe("2026-08-20T09:00:00.000Z");
    expect(coverage?.to).toBe(NOW.toISOString());
    expect(coverage?.threadCount).toBe(1);
  });

  it("proves a window that was read and found empty", () => {
    cache([]);

    const coverage = readEmailCoverage(db);
    expect(coverage).not.toBeNull();
    expect(coverage?.threadCount).toBe(0);
    expect(cachedThreads(db, NOW)).toEqual([]);
  });

  it("has no coverage at all before any read succeeds", () => {
    // Null means unknown. A caller that reads it as "empty" is the failure this table exists
    // to prevent.
    expect(readEmailCoverage(db)).toBeNull();
  });

  it("hides expired rows from the reader gates use, and keeps them for the one rendering does", () => {
    cache([thread("a", "2026-08-20T09:00:00.000Z")]);
    const wayLater = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);

    expect(cachedThreads(db, wayLater)).toEqual([]);
    expect(lastKnownThreads(db).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("reading one thread, on request", () => {
  const SCHEMA_THREAD = JSON.stringify({
    type: "object",
    properties: { threadId: { type: "string" }, messageFormat: { type: "string" } },
  });

  it("pins how much comes back rather than accepting a default", () => {
    // The server's default is FULL_CONTENT, which is what this call wants — but a default is
    // not a decision, and this is the one parameter in Zeus that governs whether message
    // bodies cross the wire.
    expect(getThreadArguments(SCHEMA_THREAD, "t1")).toEqual({
      threadId: "t1",
      messageFormat: "FULL_CONTENT",
    });
  });

  it("refuses to read at all when it can no longer choose how much it gets", () => {
    const noFormat = JSON.stringify({ type: "object", properties: { threadId: {} } });
    const noId = JSON.stringify({ type: "object", properties: { messageFormat: {} } });

    expect(() => getThreadArguments(noFormat, "t1")).toThrow(/how much it returns/u);
    expect(() => getThreadArguments(noId, "t1")).toThrow(/no thread identifier/u);
    expect(() => getThreadArguments("{oops", "t1")).toThrow(/invalid input schema/u);
  });

  it("keeps the newest messages and bounds each body", () => {
    const long = "x".repeat(5_000);
    const messages = parseThreadMessages({
      messages: Array.from({ length: 9 }, (_, index) => ({
        subject: `Message ${index}`,
        sender: "sarah@example.com",
        date: `2026-08-1${index}T09:00:00.000Z`,
        plaintextBody: index === 8 ? long : `body ${index}`,
      })),
    });

    expect(messages).toHaveLength(6);
    expect(messages.at(-1)?.subject).toBe("Message 8");
    expect(messages.at(-1)?.body?.length).toBeLessThan(long.length);
    expect(messages.at(-1)?.body?.endsWith("…")).toBe(true);
  });

  it("fails the read rather than reporting an unreadable answer as an empty thread", () => {
    expect(() => parseThreadMessages({ not_messages: [] })).toThrow(/did not contain a message list/u);
  });
})
