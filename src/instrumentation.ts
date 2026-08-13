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

  // Only after the store is known to be durable: a backup of an ephemeral volume would
  // be worse than none, because it would look like the memory was safe.
  const { startSnapshotScheduler } = await import("./server/snapshot-scheduler");
  startSnapshotScheduler();

  // Deliberately not awaited: the model download must never delay the server coming up
  // or keep it from coming up at all. Search answers from full-text until it lands.
  const { startEmbeddingWarmup } = await import("./server/embedding-warmup");
  startEmbeddingWarmup();
}
