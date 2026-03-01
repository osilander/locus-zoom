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
  const safeStart = Math.max(1, Math.min(start, contigLength));
  const safeEnd = Math.max(safeStart, Math.min(end, contigLength));
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
