import { encodeBackup, decodeBackup } from './backup.ts';
import { validateState } from './engine.ts';
import type { PortableState } from './types.ts';
import type { CodecMethod } from './codec.ts';

const scope = globalThis as unknown as {
  onmessage(event: MessageEvent<{ id: number; method: CodecMethod; input: unknown }>): void;
  postMessage(value: unknown): void;
};
let queue: Promise<unknown> = Promise.resolve();
scope.onmessage = ({ data }) => {
  // Keep memory-intensive codec jobs sequential on their own worker. These jobs
  // never read or mutate IndexedDB, so the archive worker remains independent.
  queue = queue
    .catch(() => undefined)
    .then(async () => {
      try {
        let result: unknown;
        if (data.method === 'encodeBackup')
          result = await encodeBackup(data.input as PortableState);
        else if (data.method === 'decodeBackup')
          result = await decodeBackup(data.input as Uint8Array);
        else if (data.method === 'validateState') result = await validateState(data.input);
        else throw new Error('Unknown backup processing operation.');
        scope.postMessage({ id: data.id, result });
      } catch (error) {
        scope.postMessage({
          id: data.id,
          errorName: error instanceof Error ? error.name : 'Error',
          error: error instanceof Error ? error.message : 'Backup processing failed.'
        });
      }
    });
};
