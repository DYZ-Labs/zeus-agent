export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Before anything can open a store: refuse to serve a hosted deployment whose memory
  // would land on ephemeral storage. Throwing here fails the deploy loudly, which is
  // the only outcome better than silently handing every account an empty database.
  const [{ getAuthConfiguration }, { assertPersistentStoreConfigured }] = await Promise.all([
    import("./server/auth/config"),
    import("./server/persistence"),
  ]);
  assertPersistentStoreConfigured(getAuthConfiguration());

  const { logResolvedModelOnce } = await import("./core/openai");
  logResolvedModelOnce();
}
