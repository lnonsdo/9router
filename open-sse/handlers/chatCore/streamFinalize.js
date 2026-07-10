/**
 * Wraps a ReadableStream so a `finalize` callback runs exactly once when the
 * stream is fully drained, errors, or is cancelled.
 */
export function wrapReadableStreamWithFinalize(readable, finalize) {
  const reader = readable.getReader();
  let finalized = false;

  const runFinalize = () => {
    if (finalized) return;
    finalized = true;
    finalize();
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          runFinalize();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        runFinalize();
        controller.error(error);
      }
    },

    async cancel(reason) {
      runFinalize();
      try {
        await reader.cancel(reason);
      } catch {
        // Ignored
      }
    },
  });
}
