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

  // Bound the write-ahead log for a process that stays up for weeks, and fold it back
  // in when this one is asked to stop.
  const { startDurabilityMaintenance } = await import("./server/durability");
  startDurabilityMaintenance();

  // Keep the cached calendar current where no LaunchAgent does it, so the detectors this
  // deployment ships actually run. Refresh only; nothing here interrupts anyone.
  const { startAmbientScheduler } = await import("./server/ambient-scheduler");
  startAmbientScheduler();

  // Deliberately not awaited: the model download must never delay the server coming up
  // or keep it from coming up at all. Search answers from full-text until it lands.
  const { startEmbeddingWarmup } = await import("./server/embedding-warmup");
  startEmbeddingWarmup();
}
