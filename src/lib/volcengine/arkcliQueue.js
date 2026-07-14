/**
 * Simple serialization queue for arkcli subprocess calls.
 *
 * Concurrent arkcli processes (even across different isolated HOME dirs)
 * can cause token refresh race conditions when arkcli rotates refresh_tokens.
 * Serialize all arkcli calls with a small gap between executions to avoid this.
 */

// Minimum delay (ms) between consecutive arkcli invocations to prevent
// tight-loop token refresh races when multiple accounts are queried.
const ARKCLI_CALL_GAP_MS = 2000;

let arkcliQueue = Promise.resolve();
let lastFinishTime = 0;

export function runArkcliSerialized(fn) {
  const next = arkcliQueue.then(
    () => {
      const wait = Math.max(0, lastFinishTime + ARKCLI_CALL_GAP_MS - Date.now());
      return (wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve())
        .then(fn)
        .finally(() => {
          lastFinishTime = Date.now();
        });
    },
    () => {
      const wait = Math.max(0, lastFinishTime + ARKCLI_CALL_GAP_MS - Date.now());
      return (wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve())
        .then(fn)
        .finally(() => {
          lastFinishTime = Date.now();
        });
    }
  );
  // Chain but don't propagate failures to the next in queue
  arkcliQueue = next.catch(() => {});
  return next;
}
