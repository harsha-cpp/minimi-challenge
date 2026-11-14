import type { SearchProvider } from "./types.ts";

export function withConcurrency(provider: SearchProvider, max = 4, maxQueued = 64): SearchProvider {
  if (!Number.isInteger(max) || max < 1) throw new Error("Invalid search concurrency.");
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    async search(query, signal) {
      signal?.throwIfAborted();
      if (active >= max) {
        if (queue.length >= maxQueued) throw new Error("Search is busy; try again shortly.");
        await new Promise<void>((resolve, reject) => {
          const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => {
            const index = queue.indexOf(ready);
            if (index !== -1) queue.splice(index, 1);
            reject(signal?.reason);
          };
          queue.push(ready);
          signal?.addEventListener("abort", abort, { once: true });
        });
      } else active++;
      try {
        signal?.throwIfAborted();
        return await provider.search(query, signal);
      } finally {
        const next = queue.shift();
        if (next) next();
        else active--;
      }
    },
  };
}
