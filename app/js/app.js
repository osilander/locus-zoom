import { createSessionIndexes, fetchAlignments, fetchAnnotations, fetchManifest, fetchReference, fetchVariants, loadSession } from "./api.js";
import { canResolveNativePaths, extractDroppedPaths, inferFileSlots } from "./desktop-bridge.js";
import { renderAnnotations, renderCoverage, renderNavigator, renderReads, renderReference, renderSummary, renderVariantDetail, renderVariantList, renderVariants } from "./renderers.js";
import { createStore, normalizeWindow, parseLocus } from "./state.js";

const store = createStore({
  session: null,
  contig: "",
  contigLength: 1,
  start: 1,
  end: 120,
  reference: null,
  alignments: null,
  variants: [],
  nearbyVariants: [],
  annotations: [],
  selectedVariant: null,
  loadingReads: false,
  loadingReadTracks: [],
  autoLoadReads: false,
  alignmentSort: "base",
  alignmentGroup: "none",
  coverageLogScale: false,
  readColorPalette: "default",
  annotationExpanded: false,
  readFilters: {
    hideSecondary: false,
    hideSupplementary: false,
    hideLowMapq: false,
  },
  collapsedTracks: {},
  coverageOnlyTracks: {},
  trackOrder: [],
});

const elements = {
  status: document.querySelector("#status-pill"),
  statusLabel: document.querySelector("#status-pill-label"),
  statusProgress: document.querySelector("#status-pill-progress"),
  statusProgressBar: document.querySelector("#status-pill-progress-bar"),
  windowLabel: document.querySelector("#window-label"),
  contigSelect: document.querySelector("#contig-select"),
  startInput: document.querySelector("#start-input"),
  endInput: document.querySelector("#end-input"),
  locusInput: document.querySelector("#locus-input"),
  goButton: document.querySelector("#go-button"),
  prevButton: document.querySelector("#prev-button"),
  nextButton: document.querySelector("#next-button"),
  prevVariantButton: document.querySelector("#prev-variant-button"),
  nextVariantButton: document.querySelector("#next-variant-button"),
  homeButton: document.querySelector("#home-button"),
  zoomInButton: document.querySelector("#zoom-in-button"),
  zoomOutButton: document.querySelector("#zoom-out-button"),
  referenceTrack: document.querySelector("#reference-track"),
  navigatorCanvas: document.querySelector("#navigator-canvas"),
  alignmentTrackStack: document.querySelector("#alignment-track-stack"),
  variantTrack: document.querySelector("#variant-track"),
  variantCanvas: document.querySelector("#variant-canvas"),
  annotationTrack: document.querySelector("#annotation-track"),
  annotationTrackMeta: document.querySelector("#annotation-track-meta"),
  annotationToggleButton: document.querySelector("#annotation-toggle-button"),
  variantList: document.querySelector("#variant-list"),
  variantDetail: document.querySelector("#variant-detail"),
  summaryList: document.querySelector("#summary-list"),
  sessionDetail: document.querySelector("#session-detail"),
  dropZone: document.querySelector("#drop-zone"),
  referencePathInput: document.querySelector("#reference-path-input"),
  bamPathInput: document.querySelector("#bam-path-input"),
  vcfPathInput: document.querySelector("#vcf-path-input"),
  gffPathInput: document.querySelector("#gff-path-input"),
  loadDataButton: document.querySelector("#load-data-button"),
  confirmModal: document.querySelector("#confirm-modal"),
  confirmModalTitle: document.querySelector("#confirm-modal-title"),
  confirmModalMessage: document.querySelector("#confirm-modal-message"),
  confirmModalConfirm: document.querySelector("#confirm-modal-confirm"),
  confirmModalCancel: document.querySelector("#confirm-modal-cancel"),
};

let sharedScrollLeft = 0;
let syncingScroll = false;
let refreshToken = 0;
let activeWindowController = null;
let activeReadsController = null;
let activeReadsTimeoutId = null;
let scheduledRefreshTimer = null;
let pendingCenterPosition = null;
const REFERENCE_SEQUENCE_MAX_BASES = 5000;
const COVERAGE_BIN_THRESHOLD = 5000;
const COVERAGE_BIN_COUNT = 900;
const READ_AUTOLOAD_MAX_BASES = 10000;
const READ_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_CONTIG_WINDOW_BASES = 100000;
const WINDOW_CACHE_LIMIT = 18;
const REFRESH_DEBOUNCE_MS = 90;
const windowCache = {
  reference: new Map(),
  coverage: new Map(),
  variants: new Map(),
  annotations: new Map(),
  reads: new Map(),
};

const READ_COLOR_PALETTES = {
  default: {
    reverse: "rgba(255, 184, 107, 0.8)",
    secondary: "rgba(172, 189, 214, 0.9)",
    supplementary: "rgba(255, 122, 162, 0.82)",
    directionForward: "#2f89c6",
    directionReverse: "#c18f2f",
  },
  contrast: {
    reverse: "rgba(255, 140, 66, 0.9)",
    secondary: "rgba(116, 137, 170, 0.92)",
    supplementary: "rgba(220, 53, 69, 0.88)",
    directionForward: "#1565c0",
    directionReverse: "#d97706",
  },
  muted: {
    reverse: "rgba(214, 163, 97, 0.76)",
    secondary: "rgba(162, 172, 188, 0.86)",
    supplementary: "rgba(214, 127, 160, 0.8)",
    directionForward: "#4a8fb8",
    directionReverse: "#b9853b",
  },
};

function getHorizontalScrollers() {
  return Array.from(document.querySelectorAll("[data-sync-scroll='x']"));
}

function applyReadPalette(paletteName) {
  const palette = READ_COLOR_PALETTES[paletteName] || READ_COLOR_PALETTES.default;
  const root = document.documentElement;
  root.style.setProperty("--read-reverse", palette.reverse);
  root.style.setProperty("--read-secondary", palette.secondary);
  root.style.setProperty("--read-supplementary", palette.supplementary);
  root.style.setProperty("--read-direction-forward", palette.directionForward);
  root.style.setProperty("--read-direction-reverse", palette.directionReverse);
}

function minWindowBasesForZoom() {
  return 12;
}

function currentViewportMetrics(state = store.getState()) {
  const anchor = getHorizontalScrollers()[0];
  const scrollWidth = anchor?.scrollWidth || 0;
  const clientWidth = anchor?.clientWidth || 0;
  const windowWidth = Math.max(state.end - state.start + 1, 1);
  const normalizedCenter = scrollWidth > 0
    ? Math.max(0, Math.min(1, (sharedScrollLeft + clientWidth / 2) / scrollWidth))
    : 0.5;
  const centerBase = Math.max(
    state.start,
    Math.min(
      state.end,
      state.start + Math.round(normalizedCenter * Math.max(windowWidth - 1, 0))
    )
  );
  return {
    centerBase,
    clientWidth,
    scrollWidth,
  };
}

function applyPendingViewportCenter(state = store.getState()) {
  if (pendingCenterPosition == null) {
    return;
  }
  const anchor = getHorizontalScrollers()[0];
  if (!anchor) {
    return;
  }
  const baseCount = Math.max(state.end - state.start + 1, 1);
  const scrollWidth = anchor.scrollWidth || 0;
  const clientWidth = anchor.clientWidth || 0;
  if (scrollWidth <= clientWidth) {
    pendingCenterPosition = null;
    sharedScrollLeft = 0;
    applySharedScroll();
    return;
  }

  const relative = Math.max(
    0,
    Math.min(1, ((pendingCenterPosition - state.start) + 0.5) / baseCount)
  );
  pendingCenterPosition = null;
  sharedScrollLeft = Math.max(0, Math.min(scrollWidth - clientWidth, relative * scrollWidth - clientWidth / 2));
  applySharedScroll();
}

function setStatus(message, isError = false, options = {}) {
  const { progress = null, loading = null } = options;
  const showProgress = loading ?? (!isError && /^(Loading|Creating)/.test(String(message || "")));
  const normalizedProgress = typeof progress === "number"
    ? Math.max(0, Math.min(1, progress))
    : null;

  elements.statusLabel.textContent = message;
  elements.status.style.background = isError ? "rgba(181,71,45,0.14)" : "rgba(43,106,71,0.12)";
  elements.status.style.color = isError ? "#8a2a16" : "#1e5336";

  if (!showProgress) {
    elements.statusProgress.hidden = true;
    elements.statusProgressBar.classList.remove("is-indeterminate");
    elements.statusProgressBar.style.width = "0%";
    return;
  }

  elements.statusProgress.hidden = false;
  if (normalizedProgress == null) {
    elements.statusProgressBar.classList.add("is-indeterminate");
    elements.statusProgressBar.style.width = "";
    return;
  }

  elements.statusProgressBar.classList.remove("is-indeterminate");
  elements.statusProgressBar.style.width = `${Math.round(normalizedProgress * 100)}%`;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function sessionCacheKey(session) {
  if (!session) {
    return "no-session";
  }
  return [
    session.reference || "",
    ...(session.bams || []),
    session.vcf || "",
    session.gff || "",
  ].join("|");
}

function windowKey(state, extra = "") {
  return [
    sessionCacheKey(state.session),
    state.contig,
    state.start,
    state.end,
    extra,
  ].join("::");
}

function getCached(cache, key) {
  if (!cache.has(key)) {
    return null;
  }
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setCached(cache, key, value) {
  const taggedValue = value && typeof value === "object"
    ? {
      ...value,
      __cacheSessionKey: sessionCacheKey(store.getState().session),
    }
    : value;
  cache.set(key, taggedValue);
  while (cache.size > WINDOW_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  return taggedValue;
}

function clearWindowCaches() {
  Object.values(windowCache).forEach((cache) => cache.clear());
}

function clearActiveReadsTimeout() {
  if (activeReadsTimeoutId) {
    clearTimeout(activeReadsTimeoutId);
    activeReadsTimeoutId = null;
  }
}

function exactCoverageSubset(payload, start, end) {
  if (!payload || payload.coverageBinned) {
    return null;
  }
  if (payload.start > start || payload.end < end) {
    return null;
  }
  return {
    ...payload,
    start,
    end,
    tracks: (payload.tracks || []).map((track) => ({
      ...track,
      coverage: (track.coverage || []).filter((point) => {
        const pointStart = point.start ?? point.position ?? 0;
        const pointEnd = point.end ?? point.position ?? 0;
        return pointEnd >= start && pointStart <= end;
      }),
      reads: [],
      readsLoaded: false,
      totalReadCount: 0,
      truncated: false,
    })),
    truncated: false,
    totalReadCount: 0,
    readsLoaded: false,
    loadedReadPaths: [],
  };
}

function findRangeCached(cache, state, deriveValue) {
  const currentSessionKey = sessionCacheKey(state.session);
  for (const value of cache.values()) {
    if (!value || value.contig !== state.contig) {
      continue;
    }
    if (value.__cacheSessionKey !== currentSessionKey) {
      continue;
    }
    if (value.start > state.start || value.end < state.end) {
      continue;
    }
    const derived = deriveValue(value);
    if (derived) {
      return derived;
    }
  }
  return null;
}

function getCachedReferenceWindow(state, key) {
  const exact = getCached(windowCache.reference, key);
  if (exact) {
    return exact;
  }
  return findRangeCached(windowCache.reference, state, (cached) => {
    if (!cached.sequence) {
      return null;
    }
    const offsetStart = Math.max(state.start - cached.start, 0);
    const offsetEnd = offsetStart + (state.end - state.start + 1);
    return {
      contig: state.contig,
      start: state.start,
      end: state.end,
      sequence: cached.sequence.slice(offsetStart, offsetEnd),
    };
  });
}

function getCachedCoverageWindow(state, key) {
  const exact = getCached(windowCache.coverage, key);
  if (exact) {
    return exact;
  }
  return findRangeCached(windowCache.coverage, state, (cached) => exactCoverageSubset(cached, state.start, state.end));
}

function mergeReadTracks(existingAlignments, readPayload) {
  if (!existingAlignments) {
    return readPayload;
  }
  const tracksByPath = new Map((readPayload.tracks || []).map((track) => [track.path, track]));
  const mergedTracks = (existingAlignments.tracks || []).map((track) => {
    const incoming = tracksByPath.get(track.path);
    if (!incoming || !incoming.readsLoaded) {
      return track;
    }
    return {
      ...track,
      reads: incoming.reads,
      truncated: incoming.truncated,
      totalReadCount: incoming.totalReadCount,
      readsLoaded: true,
    };
  });
  return {
    ...existingAlignments,
    truncated: mergedTracks.some((track) => track.truncated),
    totalReadCount: mergedTracks.reduce((sum, track) => sum + (track.readsLoaded ? (track.totalReadCount || 0) : 0), 0),
    readsLoaded: false,
    loadedReadPaths: Array.from(new Set([
      ...(existingAlignments.loadedReadPaths || []),
      ...(readPayload.loadedReadPaths || []),
    ])),
    tracks: mergedTracks,
  };
}

function scheduleRefresh(immediate = false) {
  if (scheduledRefreshTimer) {
    clearTimeout(scheduledRefreshTimer);
    scheduledRefreshTimer = null;
  }

  if (immediate) {
    refreshWindow();
    return;
  }

  scheduledRefreshTimer = window.setTimeout(() => {
    scheduledRefreshTimer = null;
    refreshWindow();
  }, REFRESH_DEBOUNCE_MS);
}

function setSessionInputs(session) {
  elements.referencePathInput.value = session.reference || "";
  elements.bamPathInput.value = (session.bams || (session.bam ? [session.bam] : [])).join("\n");
  elements.vcfPathInput.value = session.vcf || "";
  elements.gffPathInput.value = session.gff || "";
}

function updateContigOptions(session) {
  elements.contigSelect.innerHTML = (session.contigs || [])
    .map((contig) => `<option value="${contig.name}">${contig.name}</option>`)
    .join("");
}

function syncControls(state) {
  elements.contigSelect.value = state.contig;
  elements.startInput.value = state.start;
  elements.endInput.value = state.end;
  elements.locusInput.value = state.contig ? `${state.contig}:${state.start}-${state.end}` : "";
  elements.windowLabel.textContent = state.contig ? `${state.contig}:${state.start}-${state.end}` : "";
  if (elements.annotationToggleButton) {
    elements.annotationToggleButton.textContent = state.annotationExpanded ? "Collapse" : "Expand";
  }
  if (elements.annotationTrackMeta) {
    elements.annotationTrackMeta.textContent = state.annotationExpanded
      ? "Expanded annotation lanes (capped at 20 rows)"
      : "Collapsed annotation lane (hover for detail)";
  }
}

function renderSessionDetail(session) {
  if (!session) {
    elements.sessionDetail.textContent = "No active session.";
    return;
  }
  const formatPath = (label, path) => `${label}: ${path || "not loaded"}`;
  elements.sessionDetail.classList.remove("muted");
  elements.sessionDetail.innerHTML = [
    formatPath("Reference", session.reference),
    formatPath(
      "BAMs",
      (session.bams || []).length ? (session.bams || []).join("<br />") : "not loaded"
    ),
    formatPath("VCF", session.vcf),
    formatPath("GFF", session.gff),
  ].join("<br />");
}

async function refreshWindow() {
  const state = store.getState();
  if (!state.contig) {
    return;
  }
  if (activeWindowController) {
    activeWindowController.abort();
  }
  if (activeReadsController) {
    activeReadsController.abort();
    activeReadsController = null;
    clearActiveReadsTimeout();
  }
  activeWindowController = new AbortController();

  const windowWidth = Math.max(state.end - state.start + 1, 1);
  const coverageBins = windowWidth > COVERAGE_BIN_THRESHOLD ? COVERAGE_BIN_COUNT : 0;
  const shouldFetchReferenceSequence = windowWidth <= REFERENCE_SEQUENCE_MAX_BASES;
  const signal = activeWindowController.signal;
  const referenceOverview = {
    contig: state.contig,
    start: state.start,
    end: state.end,
    sequence: "",
  };
  const pendingAlignments = {
    contig: state.contig,
    start: state.start,
    end: state.end,
    tracks: [],
    truncated: false,
    totalReadCount: 0,
    readsLoaded: false,
    loadedReadPaths: [],
    coverageBinned: coverageBins > 0,
  };

  const requestToken = refreshToken + 1;
  refreshToken = requestToken;

  if (!shouldFetchReferenceSequence) {
    store.setState({
      reference: referenceOverview,
      alignments: state.alignments || pendingAlignments,
      variants: state.variants || [],
      nearbyVariants: state.nearbyVariants || [],
      annotations: state.annotations || [],
    });
  }

  setStatus("Loading coverage", false, { progress: 0.65, loading: true });
  try {
    const referenceKey = windowKey(state, `ref:${shouldFetchReferenceSequence ? "seq" : "overview"}`);
    const coverageKey = windowKey(state, `cov:${coverageBins}`);
    const variantsKey = windowKey(state, "vars");
    const annotationsKey = windowKey(state, "ann");

    const cachedReference = getCachedReferenceWindow(state, referenceKey);
    const cachedCoverage = getCachedCoverageWindow(state, coverageKey);
    const cachedVariants = getCached(windowCache.variants, variantsKey);
    const cachedAnnotations = getCached(windowCache.annotations, annotationsKey);

    const [reference, alignments, variantsPayload, annotationsPayload] = await Promise.all([
      cachedReference || (
        shouldFetchReferenceSequence
          ? fetchReference(state.contig, state.start, state.end, { signal })
          : Promise.resolve(referenceOverview)
      ),
      cachedCoverage || fetchAlignments(state.contig, state.start, state.end, { includeReads: false, bins: coverageBins, signal }),
      cachedVariants || fetchVariants(state.contig, state.start, state.end, { signal }),
      cachedAnnotations || fetchAnnotations(state.contig, state.start, state.end, { signal }),
    ]);

    if (requestToken !== refreshToken) {
      return;
    }

    setCached(windowCache.reference, referenceKey, reference);
    setCached(windowCache.coverage, coverageKey, alignments);
    setCached(windowCache.variants, variantsKey, variantsPayload);
    setCached(windowCache.annotations, annotationsKey, annotationsPayload);

    const latestState = store.getState();
    const canReuseLoadedReads = latestState.contig === state.contig
      && latestState.start === state.start
      && latestState.end === state.end
      && latestState.alignments
      && (latestState.alignments.loadedReadPaths || []).length > 0;
    const nextAlignments = canReuseLoadedReads
      ? mergeReadTracks(alignments, latestState.alignments)
      : alignments;

    const selectedVariant = state.selectedVariant
      ? variantsPayload.variants.find((variant) => variant.id === state.selectedVariant.id) || null
      : null;

    const trackUiState = deriveTrackUiState(nextAlignments.tracks || [], state);

    store.setState({
      reference,
      alignments: nextAlignments,
      variants: variantsPayload.variants,
      nearbyVariants: variantsPayload.nearbyVariants || [],
      annotations: annotationsPayload.annotations,
      selectedVariant,
      trackOrder: trackUiState.trackOrder,
      collapsedTracks: trackUiState.collapsedTracks,
      coverageOnlyTracks: trackUiState.coverageOnlyTracks,
      loadingReads: false,
      loadingReadTracks: [],
    });
    setStatus("Loaded locus");
    if (
      state.autoLoadReads
      && windowWidth <= READ_AUTOLOAD_MAX_BASES
      && (nextAlignments.tracks || []).some((track) => !track.readsLoaded)
    ) {
      window.setTimeout(() => {
        const latest = store.getState();
        if (
          latest.contig === state.contig
          && latest.start === state.start
          && latest.end === state.end
          && !latest.loadingReads
        ) {
          loadReadsForCurrentWindow();
        }
      }, 0);
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    setStatus(error.message, true);
  }
}

function render(state) {
  syncControls(state);
  renderSessionDetail(state.session);

  if (!state.reference || !state.alignments) {
    renderPendingTracks(state);
    return;
  }

  renderNavigator(elements.navigatorCanvas, {
    contigLength: state.contigLength,
    start: state.start,
    end: state.end,
    variants: [...state.variants, ...state.nearbyVariants],
    selectedVariant: state.selectedVariant,
  }, handleNavigatorJump);
  renderReference(elements.referenceTrack, state.reference, state.selectedVariant);
  renderAlignmentTracks(state);
  renderVariants(
    elements.variantCanvas,
    state.variants,
    { start: state.start, end: state.end },
    state.selectedVariant,
    handleVariantPick
  );
  renderAnnotations(
    elements.annotationTrack,
    state.annotations,
    { start: state.start, end: state.end },
    handleAnnotationPick,
    {
      expanded: state.annotationExpanded,
    }
  );
  renderVariantList(elements.variantList, state.variants, state.nearbyVariants, state.selectedVariant, handleVariantPick);
  renderVariantDetail(elements.variantDetail, state.selectedVariant);

  const alignmentTracks = state.alignments.tracks || [];
  const depths = alignmentTracks.flatMap((track) => (track.coverage || []).map((point) => point.depth));
  const loadedTracks = alignmentTracks.filter((track) => track.readsLoaded);
  const totalReadCount = loadedTracks.reduce((sum, track) => sum + (track.totalReadCount || 0), 0);
  renderSummary(elements.summaryList, {
    contig: state.contig,
    start: state.start,
    end: state.end,
    readCount: loadedTracks.length ? totalReadCount : "coverage only",
    variantCount: state.variants.length,
    annotationCount: state.annotations.length,
    maxDepth: depths.length ? Math.max(...depths) : 0,
  });

  applySharedScroll();
  applyPendingViewportCenter(state);
}

function renderPendingTracks(state) {
  elements.referenceTrack.textContent = state.contig ? "Loading reference..." : "No reference sequence loaded.";
  const hasAlignmentFiles = Boolean(state.session?.bams?.length);
  const pendingMeta = state.contig
    ? "Loading coverage"
    : hasAlignmentFiles
      ? `${state.session.bams.length} BAM tracks ready`
      : "No BAM tracks loaded";
  const pendingBody = state.contig
    ? "Loading coverage for the selected locus..."
    : hasAlignmentFiles
      ? "Select a contig or locus to inspect coverage and read evidence."
      : "Load one or more BAM / CRAM files to inspect read evidence.";
  elements.alignmentTrackStack.innerHTML = `
    <div class="track-card">
      <div class="track-header">
        <span>Alignments</span>
        <span class="track-meta">${pendingMeta}</span>
      </div>
      <div class="track-body muted">${pendingBody}</div>
    </div>
  `;
  elements.variantList.textContent = state.reference ? "" : "Loading variants...";
  elements.annotationTrack.textContent = state.reference ? "" : "Loading annotations...";
}

function renderAlignmentTracks(state) {
  elements.alignmentTrackStack.innerHTML = "";

  const tracks = orderAlignmentTracks(state.alignments?.tracks || [], state.trackOrder);
  if (!tracks.length) {
    const card = document.createElement("div");
    card.className = "track-card";
    card.innerHTML = `
      <div class="track-header">
        <span>Alignments</span>
        <span class="track-meta">No BAM tracks loaded</span>
      </div>
      <div class="track-body muted">Load one or more BAM / CRAM files to inspect read evidence.</div>
    `;
    elements.alignmentTrackStack.appendChild(card);
    return;
  }

  const bulkCard = document.createElement("div");
  bulkCard.className = "track-card";
  bulkCard.classList.add("sticky-controls-card");
  bulkCard.innerHTML = `
    <div class="track-header">
      <span>Alignment Track Controls</span>
      <div class="track-header-controls">
        <span class="track-meta">${tracks.length} BAM tracks loaded</span>
      </div>
    </div>
  `;
  const bulkControls = bulkCard.querySelector(".track-header-controls");
  const bulkPrimaryButton = document.createElement("button");
  bulkPrimaryButton.type = "button";
  bulkPrimaryButton.className = "track-inline-button";
  const anyTrackMissingReads = tracks.some((track) => !track.readsLoaded);
  if (anyTrackMissingReads) {
    bulkPrimaryButton.textContent = "Load All Reads In View";
    bulkPrimaryButton.disabled = Math.max(state.end - state.start + 1, 1) > READ_AUTOLOAD_MAX_BASES || state.loadingReads;
    bulkPrimaryButton.addEventListener("click", () => loadReadsForCurrentWindow());
  } else {
    bulkPrimaryButton.textContent = allTracksCoverageOnly(tracks, state) ? "Show All Reads" : "Coverage Only All";
    bulkPrimaryButton.addEventListener("click", () => toggleAllCoverageOnly(tracks));
  }
  const filterSecondaryButton = document.createElement("button");
  filterSecondaryButton.type = "button";
  filterSecondaryButton.className = "track-inline-button";
  filterSecondaryButton.textContent = state.readFilters.hideSecondary ? "Show Secondary" : "Hide Secondary";
  filterSecondaryButton.addEventListener("click", () => toggleReadFilter("hideSecondary"));
  const filterSupplementaryButton = document.createElement("button");
  filterSupplementaryButton.type = "button";
  filterSupplementaryButton.className = "track-inline-button";
  filterSupplementaryButton.textContent = state.readFilters.hideSupplementary ? "Show Supplementary" : "Hide Supplementary";
  filterSupplementaryButton.addEventListener("click", () => toggleReadFilter("hideSupplementary"));
  const filterMapqButton = document.createElement("button");
  filterMapqButton.type = "button";
  filterMapqButton.className = "track-inline-button";
  filterMapqButton.textContent = state.readFilters.hideLowMapq ? "Show Low MQ" : "Hide Low MQ";
  filterMapqButton.addEventListener("click", () => toggleReadFilter("hideLowMapq"));
  const sortSelect = document.createElement("select");
  sortSelect.className = "track-inline-select";
  sortSelect.innerHTML = `
    <option value="base">Sort: Base at site</option>
    <option value="insertSize">Sort: Insert size</option>
    <option value="strand">Sort: Strand</option>
  `;
  sortSelect.value = state.alignmentSort;
  sortSelect.addEventListener("change", (event) => setAlignmentSort(event.target.value));
  const groupSelect = document.createElement("select");
  groupSelect.className = "track-inline-select";
  groupSelect.innerHTML = `
    <option value="none">Group: None</option>
    <option value="strand">Group: Strand</option>
    <option value="sample">Group: Sample</option>
    <option value="readGroup">Group: Read group</option>
    <option value="haplotype">Group: Haplotype tag (HP)</option>
  `;
  groupSelect.value = state.alignmentGroup;
  groupSelect.addEventListener("change", (event) => setAlignmentGroup(event.target.value));
  const coverageScaleButton = document.createElement("button");
  coverageScaleButton.type = "button";
  coverageScaleButton.className = "track-inline-button";
  coverageScaleButton.textContent = state.coverageLogScale ? "Coverage: Log" : "Coverage: Linear";
  coverageScaleButton.addEventListener("click", toggleCoverageScale);
  const autoLoadButton = document.createElement("button");
  autoLoadButton.type = "button";
  autoLoadButton.className = "track-inline-button";
  autoLoadButton.textContent = state.autoLoadReads ? "Auto Reads: On" : "Auto Reads: Off";
  autoLoadButton.addEventListener("click", toggleAutoLoadReads);
  const paletteSelect = document.createElement("select");
  paletteSelect.className = "track-inline-select";
  paletteSelect.innerHTML = `
    <option value="default">Colors: Default</option>
    <option value="contrast">Colors: Contrast</option>
    <option value="muted">Colors: Muted</option>
  `;
  paletteSelect.value = state.readColorPalette;
  paletteSelect.addEventListener("change", (event) => setReadColorPalette(event.target.value));
  bulkControls.appendChild(bulkPrimaryButton);
  bulkControls.appendChild(sortSelect);
  bulkControls.appendChild(groupSelect);
  bulkControls.appendChild(coverageScaleButton);
  bulkControls.appendChild(autoLoadButton);
  bulkControls.appendChild(paletteSelect);
  bulkControls.appendChild(filterSecondaryButton);
  bulkControls.appendChild(filterSupplementaryButton);
  bulkControls.appendChild(filterMapqButton);
  const legend = document.createElement("div");
  legend.className = "read-legend";
  legend.innerHTML = `
    <span class="read-legend-title">Read Colors</span>
    <span class="read-legend-item"><span class="read-legend-swatch"></span>Forward</span>
    <span class="read-legend-item"><span class="read-legend-swatch reverse"></span>Reverse</span>
    <span class="read-legend-item"><span class="read-legend-swatch secondary"></span>Secondary</span>
    <span class="read-legend-item"><span class="read-legend-swatch supplementary"></span>Supplementary</span>
    <span class="read-legend-item"><span class="read-legend-swatch low-mapq"></span>Low MQ</span>
    <span class="read-legend-item"><span class="read-legend-swatch mismatch"></span>Mismatch</span>
    <span class="read-legend-item"><span class="read-legend-swatch known-variant"></span>VCF Site</span>
  `;
  bulkCard.appendChild(legend);
  elements.alignmentTrackStack.appendChild(bulkCard);

  tracks.forEach((track, index) => {
    const card = document.createElement("div");
    card.className = "track-card";

    const header = document.createElement("div");
    header.className = "track-header";

    const title = document.createElement("span");
    title.textContent = `Alignments ${index + 1}: ${track.id}`;

    const meta = document.createElement("span");
    meta.className = "track-meta";
    const trackLoadingReads = Boolean(state.loadingReadTracks?.includes(track.path));
    meta.textContent = trackLoadingReads
      ? "Coverage loaded, reads loading"
      : !track.readsLoaded
        ? `Coverage only (${Math.max(state.end - state.start + 1, 1) > READ_AUTOLOAD_MAX_BASES ? `zoom in below ${READ_AUTOLOAD_MAX_BASES} bp to load reads` : "click Load Reads for this locus"})`
        : track.truncated
        ? `${track.reads.length} reads shown of ${track.totalReadCount}`
        : `${track.totalReadCount} reads shown`;

    const controls = document.createElement("div");
    controls.className = "track-header-controls";

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "track-inline-button";
    collapseButton.textContent = state.collapsedTracks?.[track.path] ? "Expand" : "Collapse";
    collapseButton.addEventListener("click", () => toggleTrackCollapse(track.path));

    const readsButton = document.createElement("button");
    readsButton.type = "button";
    readsButton.className = "track-inline-button";
    if (!track.readsLoaded) {
      readsButton.textContent = "Load Reads";
      readsButton.disabled = Boolean(state.collapsedTracks?.[track.path]) || state.loadingReads || Math.max(state.end - state.start + 1, 1) > READ_AUTOLOAD_MAX_BASES;
      readsButton.addEventListener("click", () => loadReadsForCurrentWindow(track.path));
    } else {
      readsButton.textContent = state.coverageOnlyTracks?.[track.path] ? "Show Reads" : "Coverage Only";
      readsButton.disabled = Boolean(state.collapsedTracks?.[track.path]);
      readsButton.addEventListener("click", () => toggleCoverageOnly(track.path));
    }

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.className = "track-inline-button";
    upButton.textContent = "Up";
    upButton.disabled = index === 0;
    upButton.addEventListener("click", () => moveTrack(track.path, -1));

    const downButton = document.createElement("button");
    downButton.type = "button";
    downButton.className = "track-inline-button";
    downButton.textContent = "Down";
    downButton.disabled = index === tracks.length - 1;
    downButton.addEventListener("click", () => moveTrack(track.path, 1));

    controls.appendChild(meta);
    controls.appendChild(collapseButton);
    controls.appendChild(readsButton);
    controls.appendChild(upButton);
    controls.appendChild(downButton);

    header.appendChild(title);
    header.appendChild(controls);

    const coverageBody = document.createElement("div");
    coverageBody.className = "track-body horizontal-track";
    coverageBody.dataset.syncScroll = "x";
    const coverageCanvas = document.createElement("canvas");
    coverageCanvas.className = "track-canvas";
    coverageCanvas.width = 1100;
    coverageCanvas.height = 140;
    coverageBody.appendChild(coverageCanvas);

    const readsBody = document.createElement("div");
    readsBody.className = "track-body reads-track";
    readsBody.dataset.syncScroll = "x";

    card.appendChild(header);
    const isCollapsed = Boolean(state.collapsedTracks?.[track.path]);
    const isCoverageOnly = Boolean(state.coverageOnlyTracks?.[track.path]);

    if (!isCollapsed) {
      card.appendChild(coverageBody);
      if (!isCoverageOnly) {
        card.appendChild(readsBody);
      }
    }
    elements.alignmentTrackStack.appendChild(card);

    if (!isCollapsed) {
      renderCoverage(
        coverageCanvas,
        track.coverage,
        state.variants,
        state.selectedVariant,
        { contig: state.contig, start: state.start, end: state.end },
        handleVariantPick,
        {
          logScale: state.coverageLogScale,
        }
      );
      if (!isCoverageOnly) {
        const visibleReads = filterReads(track.reads, state.readFilters);
        const sortedGroupedReads = organizeReadsForDisplay(visibleReads, state);
        renderReads(
          readsBody,
          sortedGroupedReads,
          state.reference,
          state.variants,
            state.selectedVariant,
          {
            cursorPosition: sortCursorPosition(state),
            emptyMessage: trackLoadingReads
              ? "Loading reads for this locus..."
              : !track.readsLoaded
              ? (Math.max(state.end - state.start + 1, 1) > READ_AUTOLOAD_MAX_BASES
                ? `Zoom in below ${READ_AUTOLOAD_MAX_BASES} bp to load reads`
                : "Click Load Reads for this locus")
              : "No visible reads after filtering.",
          }
        );
      }
    }
  });

  attachHorizontalSync();
}

function allTracksCoverageOnly(tracks, state) {
  return tracks.length > 0 && tracks.every((track) => state.coverageOnlyTracks?.[track.path]);
}

function orderAlignmentTracks(tracks, trackOrder) {
  if (!tracks.length) {
    return tracks;
  }

  const orderIndex = new Map(trackOrder.map((path, index) => [path, index]));
  return [...tracks].sort((left, right) => {
    const leftIndex = orderIndex.has(left.path) ? orderIndex.get(left.path) : Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.has(right.path) ? orderIndex.get(right.path) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.path.localeCompare(right.path);
  });
}

function deriveTrackUiState(tracks, state) {
  const currentPaths = tracks.map((track) => track.path);
  const currentSet = new Set(currentPaths);
  return {
    trackOrder: [
    ...state.trackOrder.filter((path) => currentSet.has(path)),
    ...currentPaths.filter((path) => !state.trackOrder.includes(path)),
    ],
    collapsedTracks: Object.fromEntries(
    Object.entries(state.collapsedTracks || {}).filter(([path]) => currentSet.has(path))
    ),
    coverageOnlyTracks: Object.fromEntries(
    Object.entries(state.coverageOnlyTracks || {}).filter(([path]) => currentSet.has(path))
    ),
  };
}

function filterReads(reads, filters) {
  return (reads || []).filter((read) => {
    if (filters.hideSecondary && read.secondary) {
      return false;
    }
    if (filters.hideSupplementary && read.supplementary) {
      return false;
    }
    if (filters.hideLowMapq && read.mapq < 20) {
      return false;
    }
    return true;
  });
}

function setAlignmentSort(value) {
  store.setState({ alignmentSort: value });
}

function setAlignmentGroup(value) {
  store.setState({ alignmentGroup: value });
}

function toggleCoverageScale() {
  const state = store.getState();
  store.setState({
    coverageLogScale: !state.coverageLogScale,
  });
}

function toggleAutoLoadReads() {
  const state = store.getState();
  store.setState({
    autoLoadReads: !state.autoLoadReads,
  });
}

function setReadColorPalette(value) {
  store.setState({ readColorPalette: value });
  applyReadPalette(value);
}

function sortCursorPosition(state) {
  return state.selectedVariant?.position ?? Math.round((state.start + state.end) / 2);
}

function readEntryAtPosition(read, position) {
  return (read.layout || []).find((entry) => entry.position === position) || null;
}

function baseSortRank(read, position) {
  const entry = readEntryAtPosition(read, position);
  if (!entry) {
    return 99;
  }
  if (entry.op === "D") {
    return 6;
  }
  if (entry.op === "I") {
    return 5;
  }
  const base = (entry.base || "").toUpperCase();
  return {
    A: 0,
    C: 1,
    G: 2,
    T: 3,
    N: 4,
  }[base] ?? 7;
}

function compareReads(left, right, state) {
  if (state.alignmentSort === "insertSize") {
    const delta = Math.abs(right.insertSize || 0) - Math.abs(left.insertSize || 0);
    if (delta !== 0) {
      return delta;
    }
  } else if (state.alignmentSort === "strand") {
    const delta = Number(left.reverse) - Number(right.reverse);
    if (delta !== 0) {
      return delta;
    }
  } else {
    const cursor = sortCursorPosition(state);
    const delta = baseSortRank(left, cursor) - baseSortRank(right, cursor);
    if (delta !== 0) {
      return delta;
    }
  }

  if (left.start !== right.start) {
    return left.start - right.start;
  }
  return (left.name || "").localeCompare(right.name || "");
}

function groupLabel(read, groupMode) {
  if (groupMode === "strand") {
    return read.reverse ? "Reverse strand" : "Forward strand";
  }
  if (groupMode === "sample") {
    return read.sample || "Unassigned sample";
  }
  if (groupMode === "readGroup") {
    return read.readGroup ? `RG: ${read.readGroup}` : "No read group";
  }
  if (groupMode === "haplotype") {
    return read.haplotype != null ? `HP: ${read.haplotype}` : "No HP tag";
  }
  return "Alignments";
}

function compareGroupLabels(left, right, groupMode) {
  if (groupMode === "strand") {
    const rank = {
      "Forward strand": 0,
      "Reverse strand": 1,
    };
    return (rank[left] ?? 99) - (rank[right] ?? 99);
  }
  if (groupMode === "haplotype") {
    const leftMatch = left.match(/^HP: (\d+)/);
    const rightMatch = right.match(/^HP: (\d+)/);
    if (leftMatch && rightMatch) {
      return Number(leftMatch[1]) - Number(rightMatch[1]);
    }
  }
  return left.localeCompare(right);
}

function organizeReadsForDisplay(reads, state) {
  const sortedReads = [...(reads || [])].sort((left, right) => compareReads(left, right, state));
  if (state.alignmentGroup === "none") {
    return [
      {
        label: "",
        reads: sortedReads,
      },
    ];
  }

  const groups = new Map();
  sortedReads.forEach((read) => {
    const label = groupLabel(read, state.alignmentGroup);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(read);
  });

  return [...groups.entries()]
    .sort(([leftLabel], [rightLabel]) => compareGroupLabels(leftLabel, rightLabel, state.alignmentGroup))
    .map(([label, groupReads]) => ({
      label,
      reads: groupReads,
    }));
}

function toggleReadFilter(key) {
  const state = store.getState();
  store.setState({
    readFilters: {
      ...state.readFilters,
      [key]: !state.readFilters[key],
    },
  });
}

async function loadReadsForCurrentWindow(trackPath = null) {
  const state = store.getState();
  if (!state.contig || !state.alignments || state.loadingReads) {
    return;
  }
  const targetPaths = trackPath ? [trackPath] : (state.alignments.tracks || []).filter((track) => !track.readsLoaded).map((track) => track.path);
  if (!targetPaths.length) {
    setStatus("Reads already loaded for this locus");
    return;
  }
  const windowWidth = Math.max(state.end - state.start + 1, 1);
  if (windowWidth > READ_AUTOLOAD_MAX_BASES) {
    setStatus(`Zoom in below ${READ_AUTOLOAD_MAX_BASES} bp to load reads`);
    return;
  }

  const readsKey = windowKey(state, `reads:${targetPaths.join("|")}`);
  const cachedReads = getCached(windowCache.reads, readsKey);
  if (cachedReads) {
    store.setState({
      alignments: mergeReadTracks(state.alignments, cachedReads),
      loadingReads: false,
      loadingReadTracks: [],
    });
    setStatus(
      cachedReads.truncated
        ? "Loaded reads (read list truncated for display)"
        : "Loaded reads"
    );
    return;
  }
  if (activeReadsController) {
    activeReadsController.abort();
    clearActiveReadsTimeout();
  }

  const requestToken = refreshToken + 1;
  refreshToken = requestToken;
  activeReadsController = new AbortController();
  activeReadsTimeoutId = window.setTimeout(() => {
    if (activeReadsController) {
      activeReadsController.abort();
    }
  }, READ_FETCH_TIMEOUT_MS);
  store.setState({ loadingReads: true, loadingReadTracks: targetPaths });
  setStatus("Loading reads", false, { progress: 0.82, loading: true });

  try {
    const readAlignments = await fetchAlignments(state.contig, state.start, state.end, {
      includeReads: true,
      includeCoverage: false,
      readPaths: targetPaths,
      signal: activeReadsController.signal,
    });
    if (requestToken !== refreshToken) {
      return;
    }
    if (!(readAlignments.loadedReadPaths || []).length) {
      clearActiveReadsTimeout();
      activeReadsController = null;
      store.setState({
        loadingReads: false,
        loadingReadTracks: [],
      });
      setStatus("No reads were returned for the selected track. Try a smaller window or reload the locus.", true);
      return;
    }
    clearActiveReadsTimeout();
    activeReadsController = null;
    setCached(windowCache.reads, readsKey, readAlignments);
    store.setState({
      alignments: mergeReadTracks(store.getState().alignments, readAlignments),
      loadingReads: false,
      loadingReadTracks: [],
    });
    setStatus(
      readAlignments.truncated
        ? "Loaded reads (read list truncated for display)"
        : "Loaded reads"
    );
  } catch (error) {
    clearActiveReadsTimeout();
    if (isAbortError(error)) {
      if (requestToken === refreshToken) {
        activeReadsController = null;
        store.setState({ loadingReads: false, loadingReadTracks: [] });
        setStatus("Read loading timed out after 10 seconds. Try a smaller window.", true);
      }
      return;
    }
    if (requestToken === refreshToken) {
      activeReadsController = null;
      store.setState({ loadingReads: false, loadingReadTracks: [] });
      setStatus(error.message, true);
    }
  }
}

function moveTrack(trackPath, direction) {
  const state = store.getState();
  const nextOrder = [...state.trackOrder];
  const index = nextOrder.indexOf(trackPath);
  if (index < 0) {
    return;
  }
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= nextOrder.length) {
    return;
  }
  const [moved] = nextOrder.splice(index, 1);
  nextOrder.splice(targetIndex, 0, moved);
  store.setState({ trackOrder: nextOrder });
}

function toggleTrackCollapse(trackPath) {
  const state = store.getState();
  const nextCollapsed = {
    ...state.collapsedTracks,
    [trackPath]: !state.collapsedTracks?.[trackPath],
  };
  store.setState({
    collapsedTracks: {
      ...nextCollapsed,
    },
  });
}

function toggleCoverageOnly(trackPath) {
  const state = store.getState();
  const nextCoverageOnly = {
    ...state.coverageOnlyTracks,
    [trackPath]: !state.coverageOnlyTracks?.[trackPath],
  };
  store.setState({
    coverageOnlyTracks: {
      ...nextCoverageOnly,
    },
  });
}

function toggleAllCoverageOnly(tracks) {
  const state = store.getState();
  const nextValue = !allTracksCoverageOnly(tracks, state);
  const nextCoverageOnlyTracks = { ...state.coverageOnlyTracks };

  tracks.forEach((track) => {
    if (!state.collapsedTracks?.[track.path]) {
      nextCoverageOnlyTracks[track.path] = nextValue;
    }
  });

  store.setState({
    coverageOnlyTracks: nextCoverageOnlyTracks,
  });
}

function getContigMeta(contig, session) {
  return (session?.contigs || []).find((item) => item.name === contig) || null;
}

function zoomAroundVisibleViewport(factor) {
  const state = store.getState();
  const currentWidth = Math.max(state.end - state.start + 1, 1);
  const minWidth = minWindowBasesForZoom();
  const targetWidth = Math.max(minWidth, Math.min(state.contigLength, Math.round(currentWidth * factor)));
  if (targetWidth === currentWidth) {
    if (factor < 1) {
      setStatus(`Max zoom reached (${minWidth} bases visible)`);
    } else {
      setStatus("Already at full contig view");
    }
    return;
  }
  const { centerBase } = currentViewportMetrics(state);
  pendingCenterPosition = centerBase;
  const center = centerBase;
  const nextStart = center - Math.floor(targetWidth / 2);
  const nextEnd = nextStart + targetWidth - 1;
  updateWindow({ start: nextStart, end: nextEnd }, null, { preserveScroll: true });
}

function shiftWindow(direction) {
  const state = store.getState();
  const width = Math.max(state.end - state.start + 1, 1);
  const delta = Math.max(1, Math.round(width * 0.8)) * direction;
  updateWindow({
    start: state.start + delta,
    end: state.end + delta,
  });
}

function updateWindow(nextWindow, nextContig = null, options = {}) {
  const state = store.getState();
  const contig = nextContig || state.contig;
  const contigMeta = getContigMeta(contig, state.session);
  if (!contigMeta) {
    setStatus("Unknown contig", true);
    return;
  }

  const normalized = normalizeWindow(contigMeta.length, nextWindow.start, nextWindow.end);
  if (!options.preserveScroll) {
    sharedScrollLeft = 0;
    pendingCenterPosition = null;
  }
  store.setState({
    contig,
    contigLength: contigMeta.length,
    start: normalized.start,
    end: normalized.end,
    reference: null,
    alignments: null,
    variants: [],
    nearbyVariants: [],
    annotations: [],
    selectedVariant: null,
    loadingReads: false,
    loadingReadTracks: [],
  });
  scheduleRefresh();
}

function handleVariantPick(variant) {
  const state = store.getState();
  const width = Math.max(24, Math.min(80, state.end - state.start + 1));
  const start = variant.position - Math.floor(width / 2);
  const end = start + width - 1;
  const normalized = normalizeWindow(state.contigLength, start, end);
  sharedScrollLeft = 0;
  store.setState({
    selectedVariant: variant,
    start: normalized.start,
    end: normalized.end,
    reference: null,
    alignments: null,
    variants: [],
    nearbyVariants: [],
    annotations: [],
    loadingReads: false,
    loadingReadTracks: [],
  });
  scheduleRefresh(true);
}

function handleAnnotationPick(feature) {
  const padding = Math.max(20, Math.round((feature.end - feature.start + 1) * 0.2));
  updateWindow({
    start: feature.start - padding,
    end: feature.end + padding,
  });
}

function toggleAnnotationExpanded() {
  const state = store.getState();
  store.setState({
    annotationExpanded: !state.annotationExpanded,
  });
}

function handleNavigatorJump(position) {
  const state = store.getState();
  const width = Math.max(state.end - state.start + 1, 1);
  const start = position - Math.floor(width / 2);
  const end = start + width - 1;
  updateWindow({ start, end });
}

function getKnownVariants(state) {
  const merged = [...(state.variants || []), ...(state.nearbyVariants || [])];
  const byId = new Map();
  merged.forEach((variant) => {
    if (variant?.id) {
      byId.set(variant.id, variant);
    }
  });
  return [...byId.values()].sort((left, right) => left.position - right.position);
}

function stepToVariant(direction) {
  const state = store.getState();
  const variants = getKnownVariants(state);
  if (!variants.length) {
    setStatus("No nearby variants available", true);
    return;
  }

  const anchor = state.selectedVariant?.position ?? Math.round((state.start + state.end) / 2);
  let candidate = null;

  if (direction < 0) {
    for (let index = variants.length - 1; index >= 0; index -= 1) {
      if (variants[index].position < anchor) {
        candidate = variants[index];
        break;
      }
    }
  } else {
    for (let index = 0; index < variants.length; index += 1) {
      if (variants[index].position > anchor) {
        candidate = variants[index];
        break;
      }
    }
  }

  if (!candidate) {
    setStatus(direction < 0 ? "No previous known variant" : "No next known variant");
    return;
  }

  handleVariantPick(candidate);
}

function buildSessionPayload() {
  return {
    reference: elements.referencePathInput.value,
    bam: elements.bamPathInput.value,
    vcf: elements.vcfPathInput.value,
    gff: elements.gffPathInput.value,
  };
}

function showConfirmModal({
  title = "Confirm Action",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
}) {
  return new Promise((resolve) => {
    elements.confirmModalTitle.textContent = title;
    elements.confirmModalMessage.textContent = message;
    elements.confirmModalConfirm.textContent = confirmLabel;
    elements.confirmModalCancel.textContent = cancelLabel;
    elements.confirmModal.hidden = false;

    const cleanup = () => {
      elements.confirmModal.hidden = true;
      elements.confirmModalConfirm.removeEventListener("click", handleConfirm);
      elements.confirmModalCancel.removeEventListener("click", handleCancel);
      elements.confirmModal.removeEventListener("click", handleOverlayCancel);
      window.removeEventListener("keydown", handleEscape);
    };

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    const handleOverlayCancel = (event) => {
      if (event.target === elements.confirmModal) {
        handleCancel();
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        handleCancel();
      }
    };

    elements.confirmModalConfirm.addEventListener("click", handleConfirm);
    elements.confirmModalCancel.addEventListener("click", handleCancel);
    elements.confirmModal.addEventListener("click", handleOverlayCancel);
    window.addEventListener("keydown", handleEscape);
    elements.confirmModalConfirm.focus();
  });
}

function isMissingIndexError(message) {
  const text = String(message || "");
  return text.includes("Missing FASTA index") || text.includes("Missing alignment index");
}

async function offerIndexCreationAndRetry(payload) {
  const confirmed = await showConfirmModal({
    title: "Create Missing Indexes",
    message: "One or more required index files (.fai, .bai, or .crai) are missing. Create the missing indexes now?",
    confirmLabel: "Create Indexes",
    cancelLabel: "Cancel",
  });
  if (!confirmed) {
    return false;
  }

  setStatus("Creating missing indexes", false, { progress: 0.25, loading: true });
  const result = await createSessionIndexes(payload);
  if (result.count > 0) {
    setStatus(`Created ${result.count} index file${result.count === 1 ? "" : "s"}, retrying load`);
  } else {
    setStatus("Indexes already present, retrying load");
  }
  return true;
}

async function applySession(payload, message = "Loaded local files") {
  try {
    setStatus("Loading local file session", false, { progress: 0.15, loading: true });
    if (activeWindowController) {
      activeWindowController.abort();
      activeWindowController = null;
    }
    if (activeReadsController) {
      activeReadsController.abort();
      activeReadsController = null;
      clearActiveReadsTimeout();
    }
    clearWindowCaches();
    const session = await loadSession(payload);
    updateContigOptions(session);
    setSessionInputs(session);
    const firstContig = session.contigs[0];
    const initialEnd = Math.min(firstContig.length, DEFAULT_CONTIG_WINDOW_BASES);
    sharedScrollLeft = 0;
    pendingCenterPosition = null;
    store.setState({
      session,
      contig: firstContig.name,
      contigLength: firstContig.length,
      start: 1,
      end: initialEnd,
      reference: null,
      alignments: null,
      variants: [],
      nearbyVariants: [],
      annotations: [],
      selectedVariant: null,
      loadingReads: false,
      loadingReadTracks: [],
    });
    setStatus(message, false, { progress: 0.4, loading: true });
    await refreshWindow();
  } catch (error) {
    if (isMissingIndexError(error.message)) {
      try {
        const shouldRetry = await offerIndexCreationAndRetry(payload);
        if (shouldRetry) {
          await applySession(payload, message);
          return;
        }
      } catch (indexError) {
        setStatus(indexError.message, true);
        return;
      }
    }
    setStatus(error.message, true);
  }
}

function maxSharedScrollLeft() {
  const anchor = getHorizontalScrollers()[0];
  const contentWidth = anchor?.scrollWidth || 0;
  const viewportWidth = anchor?.clientWidth || 0;
  return Math.max(0, contentWidth - viewportWidth);
}

function applySharedScroll(source = null) {
  const clamped = Math.max(0, Math.min(sharedScrollLeft, maxSharedScrollLeft()));
  sharedScrollLeft = clamped;
  syncingScroll = true;
  getHorizontalScrollers().forEach((scroller) => {
    if (scroller === source) {
      return;
    }
    scroller.scrollLeft = clamped;
  });
  if (source) {
    source.scrollLeft = clamped;
  }
  syncingScroll = false;
}

function attachHorizontalSync() {
  getHorizontalScrollers().forEach((scroller) => {
    if (scroller.dataset.syncBound === "true") {
      return;
    }
    scroller.addEventListener("scroll", () => {
      if (syncingScroll) {
        return;
      }
      sharedScrollLeft = scroller.scrollLeft;
      applySharedScroll(scroller);
    });
    scroller.dataset.syncBound = "true";
  });
}

function populateDroppedPaths(paths) {
  const inferred = inferFileSlots(paths);
  if (inferred.reference) {
    elements.referencePathInput.value = inferred.reference;
  }
  if (inferred.bams?.length) {
    elements.bamPathInput.value = inferred.bams.join("\n");
  }
  if (inferred.vcf) {
    elements.vcfPathInput.value = inferred.vcf;
  }
  if (inferred.gff) {
    elements.gffPathInput.value = inferred.gff;
  }
}

function attachDropZone() {
  const activate = (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragover");
  };

  const deactivate = (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragover");
  };

  elements.dropZone.addEventListener("dragenter", activate);
  elements.dropZone.addEventListener("dragover", activate);
  elements.dropZone.addEventListener("dragleave", deactivate);
  elements.dropZone.addEventListener("drop", async (event) => {
    deactivate(event);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    if (!canResolveNativePaths(files)) {
      setStatus("This browser cannot read dropped native paths. In the desktop shell, drop will populate them directly.", true);
      return;
    }

    const paths = extractDroppedPaths(files);
    populateDroppedPaths(paths);
    await applySession(
      buildSessionPayload(),
      "Loaded dropped local files"
    );
  });
}

function isTypingTarget(target) {
  if (!target) {
    return false;
  }
  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || target.isContentEditable;
}

function attachKeyboardShortcuts() {
  window.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      elements.goButton.click();
      return;
    }

    if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      elements.homeButton.click();
      return;
    }

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      elements.zoomInButton.click();
      return;
    }

    if (event.key === "-") {
      event.preventDefault();
      elements.zoomOutButton.click();
      return;
    }

    if (event.key === "[") {
      event.preventDefault();
      elements.prevVariantButton.click();
      return;
    }

    if (event.key === "]") {
      event.preventDefault();
      elements.nextVariantButton.click();
      return;
    }

    if (event.shiftKey && event.key === "ArrowLeft") {
      event.preventDefault();
      elements.prevButton.click();
      return;
    }

    if (event.shiftKey && event.key === "ArrowRight") {
      event.preventDefault();
      elements.nextButton.click();
    }
  });
}

function attachEvents() {
  elements.goButton.addEventListener("click", () => {
    try {
      const parsed = parseLocus(elements.locusInput.value);
      updateWindow({ start: parsed.start, end: parsed.end }, parsed.contig);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.loadDataButton.addEventListener("click", async () => {
    await applySession(buildSessionPayload());
  });

  elements.contigSelect.addEventListener("change", () => {
    const contig = elements.contigSelect.value;
    const contigMeta = getContigMeta(contig, store.getState().session);
    if (!contigMeta) {
      setStatus("Unknown contig", true);
      return;
    }
    updateWindow({ start: 1, end: Math.min(contigMeta.length, DEFAULT_CONTIG_WINDOW_BASES) }, contig);
  });

  elements.homeButton.addEventListener("click", () => {
    const state = store.getState();
    updateWindow({ start: 1, end: state.contigLength });
  });

  elements.prevButton.addEventListener("click", () => {
    shiftWindow(-1);
  });

  elements.nextButton.addEventListener("click", () => {
    shiftWindow(1);
  });

  elements.prevVariantButton.addEventListener("click", () => {
    stepToVariant(-1);
  });

  elements.nextVariantButton.addEventListener("click", () => {
    stepToVariant(1);
  });

  elements.zoomInButton.addEventListener("click", () => {
    zoomAroundVisibleViewport(0.5);
  });

  elements.zoomOutButton.addEventListener("click", () => {
    zoomAroundVisibleViewport(2);
  });

  elements.annotationToggleButton.addEventListener("click", () => {
    toggleAnnotationExpanded();
  });

  attachDropZone();
  attachKeyboardShortcuts();
  attachHorizontalSync();
  window.addEventListener("resize", () => applySharedScroll());
}

async function initialize() {
  try {
    attachEvents();
    applyReadPalette(store.getState().readColorPalette);
    setStatus("Loading demo manifest", false, { progress: 0.08, loading: true });
    const manifest = await fetchManifest();
    if (!manifest.contigs || manifest.contigs.length === 0) {
      throw new Error("Reference FASTA with .fai index is required. Use the demo generator or load local files.");
    }
    updateContigOptions(manifest);
    setSessionInputs(manifest);
    const firstContig = manifest.contigs[0];
    const initialEnd = Math.min(firstContig.length, DEFAULT_CONTIG_WINDOW_BASES);
    sharedScrollLeft = 0;
    pendingCenterPosition = null;
    store.setState({
      session: manifest,
      contig: firstContig.name,
      contigLength: firstContig.length,
      start: 1,
      end: initialEnd,
      reference: null,
      alignments: null,
      variants: [],
      nearbyVariants: [],
      annotations: [],
      selectedVariant: null,
      loadingReads: false,
      loadingReadTracks: [],
    });
    setStatus("Loaded demo session");
    await refreshWindow();
  } catch (error) {
    setStatus(error.message, true);
  }
}

store.subscribe(render);
initialize();
