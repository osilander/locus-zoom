export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  return {
    getState() {
      return state;
    },
    setState(patch) {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener(state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function normalizeWindow(contigLength, start, end) {
  const desiredWidth = Math.max(1, Math.round(end - start + 1));
  const width = Math.min(desiredWidth, Math.max(contigLength, 1));
  const maxStart = Math.max(1, contigLength - width + 1);
  const safeStart = Math.max(1, Math.min(Math.round(start), maxStart));
  const safeEnd = Math.min(contigLength, safeStart + width - 1);
  return { start: safeStart, end: safeEnd };
}

export function parseLocus(input) {
  const cleaned = input.replace(/\s+/g, "");
  const match = cleaned.match(/^([^:]+):(\d+)-(\d+)$/);
  if (!match) {
    throw new Error("Use locus format contig:start-end");
  }
  const [, contig, rawStart, rawEnd] = match;
  return {
    contig,
    start: Number.parseInt(rawStart, 10),
    end: Number.parseInt(rawEnd, 10),
  };
}
