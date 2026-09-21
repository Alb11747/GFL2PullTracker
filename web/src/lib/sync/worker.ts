import { reconcile, canonical, type Resolutions } from './reconcile.ts';
import { inspectGraph } from './graph.ts';
import { digest } from './drive.ts';
import type { Revision } from './drive.ts';
import type { PortableState } from '../local/types.ts';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ id: number; method: string; args: unknown[] }>) => void;
  postMessage: (message: unknown) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    let result: unknown;
    if (data.method === 'reconcile')
      result = reconcile(
        ...(data.args as [PortableState, PortableState, PortableState, Resolutions])
      );
    else if (data.method === 'inspect') result = inspectGraph(data.args[0] as Revision[]);
    else if (data.method === 'fingerprint')
      result = await digest(new TextEncoder().encode(canonical(data.args[0])));
    else throw new Error('Unknown sync operation.');
    scope.postMessage({ id: data.id, result });
  } catch {
    scope.postMessage({
      id: data.id,
      error: 'The cloud histories could not be processed. Local data is safe.'
    });
  }
};
