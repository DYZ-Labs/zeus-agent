/**
 * The assistant's reply, one paragraph per blank line.
 *
 * Previously a single pre-wrapped <p>, which rendered any multi-paragraph answer as an
 * undifferentiated block and gave the model no reason to break its thinking up. The chat
 * still has no Markdown parser and the system prompt still forbids Markdown; a blank line
 * is the whole of the formatting vocabulary, and this is what honours it.
 *
 * Presentational and hook-free on purpose, so the server-rendered permalink at
 * /response/[id] and the streaming client chat can share one definition of how a reply
 * looks. Splitting runs on every delta during streaming: it is a string split on text that
 * React is already re-rendering per token.
 */
export function AssistantProse({
  text,
  className,
  paragraphClassName,
  style,
}: {
  text: string;
  className?: string;
  paragraphClassName?: string;
  style?: React.CSSProperties;
}) {
  const paragraphs = splitParagraphs(text);
  return (
    <div className={className} style={style}>
      {paragraphs.map((paragraph, index) => (
        <p
          // Reply text is append-only while streaming, so a paragraph never changes index.
          key={index}
          className={`whitespace-pre-wrap${index > 0 ? " mt-3.5" : ""}${
            paragraphClassName ? ` ${paragraphClassName}` : ""
          }`}
        >
          {paragraph}
        </p>
      ))}
    </div>
  );
}

/** Blank-line separated, with a trailing partial paragraph kept so streaming stays smooth. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}
