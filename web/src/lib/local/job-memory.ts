type JobStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Active jobs survive unavailable storage; localStorage is only reload recovery. */
export class JobMemory {
  private readonly jobs = new Map<string, string | null>();
  private readonly storage: () => JobStorage | null | undefined;
  private readonly namespace: string;

  constructor(storage: () => JobStorage | null | undefined, namespace = 'gfl2-stable.job.') {
    this.storage = storage;
    this.namespace = namespace;
  }

  get(profile: string): string | null {
    if (this.jobs.has(profile)) return this.jobs.get(profile)!;
    let id: string | null = null;
    try {
      id = this.storage()?.getItem(this.namespace + profile) || null;
    } catch {
      // Blocked storage cannot prevent retries of jobs started during this visit.
    }
    this.jobs.set(profile, id);
    return id;
  }

  set(profile: string, id: string | null): void {
    // A cached null prevents a failed removal from resurrecting the previous job.
    this.jobs.set(profile, id);
    try {
      const storage = this.storage();
      if (id === null) storage?.removeItem(this.namespace + profile);
      else storage?.setItem(this.namespace + profile, id);
    } catch {
      // This cache remains authoritative even when reload recovery is unavailable.
    }
  }
}
