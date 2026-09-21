/** One pause lease per operation, including the time spent waiting to acquire it. */
export function createOperationPauses() {
  type Entry = { pending: Promise<void>; release?: () => void; retired: boolean };
  const entries = new Map<number, Entry>();
  function release(id: number) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.retired = true;
    entry.release?.();
    entry.release = undefined;
  }
  return {
    acquire(id: number, claim: () => Promise<() => void>): Promise<void> {
      const existing = entries.get(id);
      if (existing) return existing.pending;
      let resolve!: () => void;
      let reject!: (cause: unknown) => void;
      const pending = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const entry: Entry = { pending, retired: false };
      // Register before invoking the controller or awaiting its current sync pass.
      entries.set(id, entry);
      try {
        void claim().then(
          (lease) => {
            if (entry.retired) lease();
            else entry.release = lease;
            resolve();
          },
          (cause) => {
            if (entries.get(id) === entry) entries.delete(id);
            reject(cause);
          }
        );
      } catch (cause) {
        entries.delete(id);
        reject(cause);
      }
      return pending;
    },
    release,
    releaseAll() {
      for (const id of entries.keys()) release(id);
    }
  };
}
