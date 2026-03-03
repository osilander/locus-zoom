async function request(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  let payload;

  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    const rawText = await response.text();
    const trimmed = rawText.trim();
    let message = trimmed || "Request failed";
    if (trimmed.startsWith("<")) {
      message = "The backend returned HTML instead of JSON. Restart the Python server so it picks up the latest API routes.";
    }
    if (!response.ok) {
      throw new Error(message);
    }
    throw new Error(message);
  }

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

export async function fetchManifest() {
  return request("/api/manifest");
}

export async function fetchReference(contig, start, end, options = {}) {
  return request(`/api/reference?contig=${encodeURIComponent(contig)}&start=${start}&end=${end}`, options);
}

export async function fetchAlignments(contig, start, end, options = {}) {
  const includeReads = options.includeReads === false ? "0" : "1";
  const bins = options.bins ? `&bins=${options.bins}` : "";
  const readPaths = options.readPaths?.length
    ? `&readPaths=${encodeURIComponent(options.readPaths.join(","))}`
    : "";
  const includeCoverage = options.includeCoverage === false ? "&includeCoverage=0" : "";
  return request(
    `/api/alignments?contig=${encodeURIComponent(contig)}&start=${start}&end=${end}&includeReads=${includeReads}${bins}${readPaths}${includeCoverage}`,
    options
  );
}

export async function fetchVariants(contig, start, end, options = {}) {
  return request(`/api/variants?contig=${encodeURIComponent(contig)}&start=${start}&end=${end}`, options);
}

export async function fetchAnnotations(contig, start, end, options = {}) {
  return request(`/api/annotations?contig=${encodeURIComponent(contig)}&start=${start}&end=${end}`, options);
}

export async function fetchAnnotationSearch(query, options = {}) {
  const limit = options.limit ? `&limit=${options.limit}` : "";
  return request(`/api/annotations/search?q=${encodeURIComponent(query)}${limit}`, options);
}

export async function loadSession(payload) {
  return request("/api/session/load", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function createSessionIndexes(payload) {
  return request("/api/session/indexes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}
