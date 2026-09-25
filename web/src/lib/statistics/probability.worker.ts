import { dispatch, probabilityError } from './probability.ts';
import type { ProbabilityWorkerRequest, ProbabilityWorkerResponse } from './probability-types.ts';

/** Transfer ownership of completed arrays so histories never block rendering. */
export function handleProbabilityRequest(
  data: ProbabilityWorkerRequest,
  post: (message: ProbabilityWorkerResponse, transfer: Transferable[]) => void
): void {
  try {
    const result = dispatch(data);
    const transfer = [result.elite, result.featured, result.wins]
      .filter((metric) => metric !== undefined)
      .map((metric) => metric.dist.buffer as ArrayBuffer);
    post({ id: data.id, result }, transfer);
  } catch (error) {
    post({ id: data.id, error: probabilityError(error) }, []);
  }
}

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<ProbabilityWorkerRequest>) => void) | null;
    postMessage: (message: ProbabilityWorkerResponse, transfer: Transferable[]) => void;
  };
  scope.onmessage = ({ data }) =>
    handleProbabilityRequest(data, (message, transfer) => scope.postMessage(message, transfer));
}
