import { reconcile, type Resolutions } from './reconcile.ts';
import type { PortableState } from '../local/types.ts';

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{
      id: number;
      local: PortableState;
      remote: PortableState;
      base: PortableState;
      resolutions: Resolutions;
    }>
  ) => void;
  postMessage: (message: unknown) => void;
};
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({
      id: data.id,
      result: reconcile(data.local, data.remote, data.base, data.resolutions)
    });
  } catch {
    scope.postMessage({
      id: data.id,
      error: 'The cloud histories could not be merged. Local data is safe.'
    });
  }
};
