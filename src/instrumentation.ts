export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logResolvedModelOnce } = await import("./core/openai");
  logResolvedModelOnce();
}
