import { MODEL, assertResponseComplete, openai } from "./openai";

/**
 * Guest chat is deliberately separate from the durable-memory turn loop. It receives
 * only the short transcript supplied with this request, never opens the owner store,
 * and never extracts or persists memory.
 */
const GUEST_SYSTEM_PROMPT = `You are Zeus, a helpful AI assistant speaking with a guest.

You have no access to this person's Zeus account, saved memory, prior conversations, goals, commitments, or private data. Use only the messages in this temporary conversation. Never claim that you remember the guest or that this conversation will be saved. If asked what you know about them beyond this conversation, say that you do not have access to their saved Zeus memory.

Keep responses focused and brief. Lead with the answer; supporting detail comes after. A simple question gets direct prose, not unnecessary structure.`;

export type GuestChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type StreamGuestTurnOptions = {
  input: string;
  history: readonly GuestChatMessage[];
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
};

export async function streamGuestTurn(options: StreamGuestTurnOptions): Promise<string> {
  const stream = openai().responses.stream(
    {
      model: MODEL,
      max_output_tokens: 4_000,
      reasoning: { effort: "high" },
      instructions: GUEST_SYSTEM_PROMPT,
      input: [
        ...options.history.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: "user" as const, content: options.input },
      ],
      store: false,
    },
    { signal: options.signal },
  );

  if (options.onDelta) {
    stream.on("response.output_text.delta", (event) => options.onDelta?.(event.delta));
  }

  const final = await stream.finalResponse();
  assertResponseComplete(final);
  return final.output_text;
}
