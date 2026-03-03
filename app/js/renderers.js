const BASE_CELL_WIDTH = 16;
const BASE_DETAIL_MAX_BASES = 1200;
const READ_DETAIL_MAX_BASES = 1200;
const COVERAGE_TOOLTIP_MAX_BASES = 5000;
const OVERVIEW_MAX_BINS = 900;
const OVERVIEW_BIN_PIXEL_WIDTH = 4;

export { BASE_CELL_WIDTH, BASE_DETAIL_MAX_BASES };

let coverageTooltip = null;

function ensureCoverageTooltip() {
  if (coverageTooltip) {
    return coverageTooltip;
  }
  coverageTooltip = document.createElement("div");
  coverageTooltip.className = "floating-tooltip";
  coverageTooltip.hidden = true;
  document.body.appendChild(coverageTooltip);
  return coverageTooltip;
}

function hideCoverageTooltip() {
  if (coverageTooltip) {
    coverageTooltip.hidden = true;
  }
}

function showCoverageTooltip(event, content) {
  const tooltip = ensureCoverageTooltip();
  tooltip.innerHTML = content;
  tooltip.style.left = `${event.clientX + 14}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
  tooltip.hidden = false;
}

function baseCenterX(position, start, scale) {
  return (position - start) * scale + scale / 2;
}

function baseClass(base) {
  const normalized = (base || "N").toUpperCase();
  return `base base-${normalized}`;
}

function buildBaseCell(base, absolutePosition, { selectedVariant = null, mismatch = false, reverse = false, deleted = false, skipped = false, inserted = false, secondary = false, supplementary = false, lowMapq = false } = {}) {
  const cell = document.createElement("span");
  cell.className = `${baseClass(base)}${mismatch ? " mismatch" : ""}${reverse ? " reverse" : " forward"}`;
  if (deleted) {
    cell.classList.add("deletion");
  }
  if (skipped) {
    cell.classList.add("skip");
  }
  if (inserted) {
    cell.classList.add("insertion");
  }
  if (secondary) {
    cell.classList.add("secondary");
  }
  if (supplementary) {
    cell.classList.add("supplementary");
  }
  if (lowMapq) {
    cell.classList.add("low-mapq");
  }
  if (selectedVariant && absolutePosition === selectedVariant.position) {
    cell.classList.add("selected-site");
  }
  cell.title = String(absolutePosition);
  cell.textContent = inserted ? `+${(base || "").length}` : (base || "");
  return cell;
}

export function renderNavigator(canvas, navigatorState, onJump) {
  const ctx = canvas.getContext("2d");
  const width = Math.max(canvas.parentElement?.clientWidth || canvas.width, 320);
  const height = canvas.height;
  canvas.width = width;
  canvas.style.width = `${width}px`;
  ctx.clearRect(0, 0, width, height);

  if (!navigatorState?.contigLength) {
    ctx.fillStyle = "#5f675e";
    ctx.font = "14px sans-serif";
    ctx.fillText("No contig loaded", 16, 28);
    canvas.onclick = null;
    return;
  }

  const { start, end, contigLength, variants = [], selectedVariant = null } = navigatorState;
  const usableY = 40;
  ctx.strokeStyle = "rgba(69, 86, 66, 0.22)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(10, usableY);
  ctx.lineTo(width - 10, usableY);
  ctx.stroke();

  const spanWidth = Math.max(width - 20, 1);
  const scale = spanWidth / contigLength;
  const windowX = 10 + (start - 1) * scale;
  const windowWidth = Math.max((end - start + 1) * scale, 4);

  ctx.fillStyle = "rgba(78, 168, 222, 0.22)";
  ctx.fillRect(windowX, usableY - 12, windowWidth, 24);
  ctx.strokeStyle = "#2f89c6";
  ctx.lineWidth = 2;
  ctx.strokeRect(windowX, usableY - 12, windowWidth, 24);

  variants.forEach((variant) => {
    const x = 10 + (variant.position - 1) * scale;
    ctx.strokeStyle = selectedVariant?.id === variant.id ? "#7a1028" : "#ff7aa2";
    ctx.lineWidth = selectedVariant?.id === variant.id ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, usableY - 18);
    ctx.lineTo(x, usableY + 18);
    ctx.stroke();
  });

  ctx.fillStyle = "#5f675e";
  ctx.font = "12px sans-serif";
  ctx.fillText("1", 10, 72);
  ctx.fillText(String(contigLength), Math.max(width - 60, 10), 72);

  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - rect.left - 10, spanWidth));
    const position = Math.max(1, Math.min(contigLength, Math.round(x / scale) + 1));
    onJump(position);
  };
}

function buildStrip(windowWidth) {
  const strip = document.createElement("div");
  strip.className = "locus-strip";
  strip.style.width = `${windowWidth * BASE_CELL_WIDTH}px`;
  return strip;
}

function containerWidthFor(element, fallback = 1100) {
  return Math.max(element?.clientWidth || fallback, 240);
}

function packReadsIntoLanes(reads, maxLanes = 48) {
  const lanes = [];
  const laneEnds = [];

  reads.forEach((read) => {
    let laneIndex = -1;
    for (let idx = 0; idx < laneEnds.length; idx += 1) {
      if (read.start > laneEnds[idx]) {
        laneIndex = idx;
        break;
      }
    }

    if (laneIndex === -1) {
      if (lanes.length >= maxLanes) {
        return;
      }
      laneIndex = lanes.length;
      lanes.push([]);
      laneEnds.push(0);
    }

    lanes[laneIndex].push(read);
    laneEnds[laneIndex] = Math.max(laneEnds[laneIndex], read.end);
  });

  return lanes;
}

function isDetailedMode(windowBaseCount) {
  return windowBaseCount <= BASE_DETAIL_MAX_BASES;
}

function renderWidthFor(windowBaseCount, containerWidth) {
  if (isDetailedMode(windowBaseCount)) {
    return windowBaseCount * BASE_CELL_WIDTH;
  }
  const binCount = Math.min(windowBaseCount, OVERVIEW_MAX_BINS);
  return Math.max(containerWidth + 1, binCount * OVERVIEW_BIN_PIXEL_WIDTH);
}

function drawSelectionLine(ctx, x, height) {
  ctx.strokeStyle = "#7a1028";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

export function renderReference(target, referenceWindow, selectedVariant) {
  target.innerHTML = "";
  if (!referenceWindow) {
    target.textContent = "No reference sequence loaded.";
    return;
  }

  const sequence = referenceWindow.sequence || "";
  const start = referenceWindow.start;
  const end = referenceWindow.end ?? (start + Math.max(sequence.length - 1, 0));
  const windowWidth = Math.max(end - start + 1, 1);

  if (sequence && isDetailedMode(windowWidth)) {
    const ruler = buildStrip(windowWidth);
    ruler.classList.add("ruler-strip");

    for (let idx = 0; idx < windowWidth; idx += 1) {
      const position = start + idx;
      const tick = document.createElement("span");
      tick.className = "ruler-cell";
      tick.style.left = `${idx * BASE_CELL_WIDTH}px`;
      tick.textContent = idx % 10 === 0 ? String(position) : "";
      ruler.appendChild(tick);
    }

    const bases = buildStrip(windowWidth);
    bases.classList.add("base-strip");

    sequence.split("").forEach((base, idx) => {
      const cell = buildBaseCell(base, start + idx, { selectedVariant });
      cell.style.left = `${idx * BASE_CELL_WIDTH}px`;
      bases.appendChild(cell);
    });

    target.appendChild(ruler);
    target.appendChild(bases);
    return;
  }

  const width = containerWidthFor(target);
  const renderWidth = renderWidthFor(windowWidth, width);
  const height = 64;
  const scale = renderWidth / windowWidth;
  const canvas = document.createElement("canvas");
  canvas.className = "overview-canvas";
  canvas.width = renderWidth;
  canvas.height = height;
  canvas.style.width = `${renderWidth}px`;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, renderWidth, height);
  ctx.fillStyle = "#5f675e";
  ctx.font = "12px sans-serif";
  ctx.fillText(`${start}`, 8, 14);
  ctx.fillText(`${end}`, Math.max(renderWidth - 70, 8), 14);

  ctx.strokeStyle = "rgba(69, 86, 66, 0.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 34);
  ctx.lineTo(renderWidth, 34);
  ctx.stroke();

  const tickStep = Math.max(100, Math.round(windowWidth / 10));
  for (let pos = start; pos <= end; pos += tickStep) {
    const x = (pos - start) * scale;
    ctx.strokeStyle = "rgba(69, 86, 66, 0.18)";
    ctx.beginPath();
    ctx.moveTo(x, 22);
    ctx.lineTo(x, 46);
    ctx.stroke();
    ctx.fillStyle = "#5f675e";
    ctx.fillText(String(pos), Math.min(x + 2, renderWidth - 48), 58);
  }

  if (selectedVariant && selectedVariant.position >= start && selectedVariant.position <= end) {
    drawSelectionLine(ctx, baseCenterX(selectedVariant.position, start, scale), height);
  }

  target.appendChild(canvas);
}

export function renderCoverage(canvas, coverage, variants, selectedVariant, windowState, onPick, options = {}) {
  const ctx = canvas.getContext("2d");
  const { logScale = false } = options;
  const baseCount = Math.max(windowState.end - windowState.start + 1, 1);
  const detailed = isDetailedMode(baseCount);
  const width = renderWidthFor(baseCount, containerWidthFor(canvas.parentElement));
  const height = canvas.height;
  const scale = width / baseCount;
  canvas.width = width;
  canvas.style.width = `${width}px`;
  ctx.clearRect(0, 0, width, height);

  if (!coverage || coverage.length === 0) {
    canvas.onmousemove = () => hideCoverageTooltip();
    canvas.onmouseleave = () => hideCoverageTooltip();
    canvas.onclick = null;
    ctx.fillStyle = "#5f675e";
    ctx.font = "14px sans-serif";
    ctx.fillText("No reads in this locus", 16, 28);
    return;
  }

  const metric = (depth) => {
    if (!logScale) {
      return depth;
    }
    return Math.log10(depth + 1);
  };
  const maxDepth = Math.max(...coverage.map((point) => point.depth), 1);
  const maxMetric = Math.max(...coverage.map((point) => metric(point.depth)), 1);
  const baseColors = {
    A: "#90d6ff",
    C: "#a8c4ff",
    G: "#ffd699",
    T: "#ffbfde",
    N: "#cdd6e8",
  };

  coverage.forEach((point) => {
    const barHeight = (metric(point.depth) / maxMetric) * (height - 30);
    const x = ((point.start ?? point.position) - windowState.start) * scale;
    const pointWidthBases = (point.end ?? point.position) - (point.start ?? point.position) + 1;
    const y = height - barHeight - 18;
    const barWidth = Math.max(pointWidthBases * scale - 1, 1);
    const counts = point.counts || null;

    const hasFractionalCounts = Boolean(
      counts
      && point.position
      && ["A", "C", "G", "T", "N"].some((base) => (counts[base] || 0) > 0)
    );

    if (!hasFractionalCounts) {
      ctx.fillStyle = "#60c4e9";
      ctx.fillRect(x, y, barWidth, barHeight);
      return;
    }

    let currentY = y + barHeight;
    ["A", "C", "G", "T", "N"].forEach((base) => {
      const fraction = point.depth > 0 ? (counts[base] || 0) / point.depth : 0;
      if (fraction <= 0) {
        return;
      }
      const segmentHeight = Math.max(barHeight * fraction, 1);
      currentY -= segmentHeight;
      ctx.fillStyle = baseColors[base];
      ctx.fillRect(x, currentY, barWidth, segmentHeight);
    });
  });

  if (selectedVariant) {
    drawSelectionLine(ctx, baseCenterX(selectedVariant.position, windowState.start, scale), height);
  }

  ctx.fillStyle = "#5f675e";
  ctx.font = "12px sans-serif";
  ctx.fillText(`${logScale ? "Log" : "Linear"} max depth ${maxDepth}`, 14, height - 4);

  if (baseCount > COVERAGE_TOOLTIP_MAX_BASES) {
    canvas.onmousemove = () => hideCoverageTooltip();
    canvas.onmouseleave = () => hideCoverageTooltip();
    canvas.onclick = null;
    return;
  }

  const variantByPosition = new Map((variants || []).map((variant) => [variant.position, variant]));
  const depthByPosition = new Map((coverage || []).map((point) => [point.position, point.depth]));
  const countsByPosition = new Map((coverage || []).map((point) => [point.position, point.counts || null]));
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const hoveredPosition = windowState.start + Math.floor(x / scale);
    if (hoveredPosition < windowState.start || hoveredPosition > windowState.end) {
      hideCoverageTooltip();
      return;
    }
    const hoveredDepth = depthByPosition.get(hoveredPosition) ?? 0;
    const hoveredVariant = variantByPosition.get(hoveredPosition);
    const hoveredCounts = countsByPosition.get(hoveredPosition) || null;
    let content = `<strong>${windowState.contig || ""}${windowState.contig ? ":" : ""}${hoveredPosition}</strong><br />Depth: ${hoveredDepth}`;
    if (hoveredCounts && hoveredDepth > 0) {
      const parts = ["A", "C", "G", "T", "N"]
        .filter((base) => (hoveredCounts[base] || 0) > 0)
        .map((base) => `${base}:${hoveredCounts[base]}`);
      if (parts.length) {
        content += `<br />Bases: ${parts.join(" ")}`;
      }
    }
    if (hoveredVariant) {
      content += `
        <br /><br />
        <strong>${hoveredVariant.id}</strong><br />
        ${hoveredVariant.ref}→${hoveredVariant.alt}<br />
        Qual: ${hoveredVariant.qual === null ? "NA" : hoveredVariant.qual}<br />
        Filter: ${hoveredVariant.filter}
      `;
    }
    showCoverageTooltip(event, content);
  };
  canvas.onmouseleave = () => hideCoverageTooltip();
  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const hoveredPosition = windowState.start + Math.floor(x / scale);
    const hoveredVariant = variantByPosition.get(hoveredPosition);
    if (hoveredVariant && onPick) {
      onPick(hoveredVariant);
    }
  };
}

export function renderVariants(canvas, variants, windowState, selectedVariant, onPick) {
  const ctx = canvas.getContext("2d");
  const baseCount = Math.max(windowState.end - windowState.start + 1, 1);
  const width = renderWidthFor(baseCount, containerWidthFor(canvas.parentElement));
  const height = canvas.height;
  const scale = width / baseCount;
  canvas.width = width;
  canvas.style.width = `${width}px`;
  const hotspots = [];
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(69, 86, 66, 0.24)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  variants.forEach((variant) => {
    const x = baseCenterX(variant.position, windowState.start, scale);
    const active = selectedVariant && selectedVariant.id === variant.id;
    ctx.fillStyle = active ? "#7a1028" : "#c18f2f";
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x + 8, height / 2);
    ctx.lineTo(x - 8, height / 2);
    ctx.closePath();
    ctx.fill();
    hotspots.push({
      x0: x - 10,
      x1: x + 10,
      variant,
    });
  });

  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const hit = hotspots.find((spot) => x >= spot.x0 && x <= spot.x1);
    if (hit) {
      onPick(hit.variant);
    }
  };
}

function firstVisibleReadPosition(read, referenceWindow) {
  const visible = (read.layout || []).find(
    (entry) => entry.position >= referenceWindow.start && entry.position <= referenceWindow.end
  );
  if (visible) {
    return visible.position;
  }
  if (read.start >= referenceWindow.start && read.start <= referenceWindow.end) {
    return read.start;
  }
  if (read.end >= referenceWindow.start && read.end <= referenceWindow.end) {
    return referenceWindow.start;
  }
  return null;
}

export function renderReads(target, readGroups, referenceWindow, variants, selectedVariant, options = {}) {
  target.innerHTML = "";
  const groups = (readGroups || []).filter((group) => (group.reads || []).length > 0);
  if (!groups.length) {
    target.textContent = options.emptyMessage || "No reads overlap this locus.";
    return;
  }

  const windowWidth = referenceWindow.end - referenceWindow.start + 1;
  const detailed = windowWidth <= READ_DETAIL_MAX_BASES;
  const width = renderWidthFor(windowWidth, containerWidthFor(target));
  const scale = width / windowWidth;
  const cursorPosition = options.cursorPosition ?? null;
  const visibleVariants = (variants || []).filter(
    (variant) => variant.position >= referenceWindow.start && variant.position <= referenceWindow.end
  );

  groups.forEach((group) => {
    if (group.label) {
      const groupHeader = document.createElement("div");
      groupHeader.className = "read-group-header";
      groupHeader.textContent = group.label;
      target.appendChild(groupHeader);
    }

    const lanes = packReadsIntoLanes(group.reads || []);

    lanes.forEach((laneReads) => {
      const row = document.createElement("div");
      row.className = "read-row";

      if (detailed) {
        const segment = buildStrip(windowWidth);
        segment.classList.add("read-strip");
        segment.title = `${laneReads.length} packed reads`;

        laneReads.forEach((read) => {
          const clippedStart = Math.max(read.start, referenceWindow.start);
          const clippedEnd = Math.min(read.end, referenceWindow.end);
          if (clippedEnd >= clippedStart) {
            const left = (clippedStart - referenceWindow.start) * BASE_CELL_WIDTH;
            const railWidth = Math.max((clippedEnd - clippedStart + 1) * BASE_CELL_WIDTH, 2);
            const topRail = document.createElement("span");
            topRail.className = `read-status-rail top${read.reverse ? " reverse" : " forward"}${read.secondary ? " secondary" : ""}${read.supplementary ? " supplementary" : ""}${read.mapq < 20 ? " low-mapq" : ""}`;
            topRail.style.left = `${left}px`;
            topRail.style.width = `${railWidth}px`;
            topRail.title = `${read.name} ${read.reverse ? "reverse" : "forward"} strand`;
            segment.appendChild(topRail);

            const bottomRail = document.createElement("span");
            bottomRail.className = `read-status-rail bottom${read.reverse ? " reverse" : " forward"}${read.secondary ? " secondary" : ""}${read.supplementary ? " supplementary" : ""}${read.mapq < 20 ? " low-mapq" : ""}`;
            bottomRail.style.left = `${left}px`;
            bottomRail.style.width = `${railWidth}px`;
            bottomRail.title = `${read.name} ${read.reverse ? "reverse" : "forward"} strand`;
            segment.appendChild(bottomRail);
          }

          (read.layout || []).forEach((entry) => {
            const absolutePosition = entry.position;
            if (absolutePosition < referenceWindow.start || absolutePosition > referenceWindow.end) {
              return;
            }
            const localIndex = absolutePosition - referenceWindow.start;
            const refBase = referenceWindow.sequence[localIndex];
            const isReferenceBase = Boolean(entry.base) && !["N", "I"].includes(entry.op);
            const mismatch = isReferenceBase && entry.op !== "D"
              ? Boolean(refBase) && refBase.toUpperCase() !== entry.base.toUpperCase()
              : false;
            const baseEl = buildBaseCell(entry.base || (entry.op === "D" ? "-" : ""), absolutePosition, {
              selectedVariant,
              mismatch,
              reverse: read.reverse,
              deleted: entry.op === "D",
              skipped: entry.op === "N",
              inserted: entry.op === "I",
              secondary: read.secondary,
              supplementary: read.supplementary,
              lowMapq: read.mapq < 20,
            });
            baseEl.style.left = `${localIndex * BASE_CELL_WIDTH}px`;
            baseEl.style.top = "8px";
            const strandLabel = read.reverse ? "reverse" : "forward";
            const cursorNote = cursorPosition && absolutePosition === cursorPosition ? " at sort site" : "";
            if (entry.op === "I") {
              baseEl.title = `${read.name} ${absolutePosition} +${entry.base} MQ:${read.mapq} ${strandLabel}${cursorNote}`;
            } else {
              baseEl.title = `${read.name} ${absolutePosition} ${entry.op} MQ:${read.mapq} ${strandLabel}${cursorNote}`;
            }
            segment.appendChild(baseEl);
          });
        });

        row.appendChild(segment);
      } else {
        row.classList.add("read-overview-row");
        row.style.width = `${width}px`;
        row.title = `${laneReads.length} packed reads`;

        laneReads.forEach((read) => {
          const bar = document.createElement("div");
          bar.className = `read-overview-bar${read.reverse ? " reverse" : ""}${read.secondary ? " secondary" : ""}${read.supplementary ? " supplementary" : ""}${read.mapq < 20 ? " low-mapq" : ""}`;
          const clippedStart = Math.max(read.start, referenceWindow.start);
          const clippedEnd = Math.min(read.end, referenceWindow.end);
          const left = (clippedStart - referenceWindow.start) * scale;
          const barWidth = Math.max((clippedEnd - clippedStart + 1) * scale, 1.5);
          bar.style.left = `${left}px`;
          bar.style.width = `${barWidth}px`;
          bar.title = `${read.name}  MQ:${read.mapq}  ${read.start}-${read.end}  ${read.reverse ? "reverse" : "forward"} strand`;
          row.appendChild(bar);
        });

        if (selectedVariant) {
          const guide = document.createElement("div");
          guide.className = "read-guide-line";
          guide.style.left = `${baseCenterX(selectedVariant.position, referenceWindow.start, scale)}px`;
          row.appendChild(guide);
        }

        visibleVariants.forEach((variant) => {
          const marker = document.createElement("div");
          marker.className = `read-overview-variant-marker${selectedVariant && selectedVariant.id === variant.id ? " selected" : ""}`;
          marker.style.left = `${baseCenterX(variant.position, referenceWindow.start, scale)}px`;
          marker.title = `${variant.id} ${variant.ref}→${variant.alt}`;
          row.appendChild(marker);
        });
      }

      target.appendChild(row);
    });
  });
}

function packFeaturesIntoLanes(features, maxLanes = 20) {
  const lanes = [];
  const laneEnds = [];

  features.forEach((feature) => {
    let laneIndex = -1;
    for (let index = 0; index < laneEnds.length; index += 1) {
      if (feature.start > laneEnds[index]) {
        laneIndex = index;
        break;
      }
    }
    if (laneIndex === -1) {
      if (lanes.length >= maxLanes) {
        return;
      }
      laneIndex = lanes.length;
      lanes.push([]);
      laneEnds.push(0);
    }
    lanes[laneIndex].push(feature);
    laneEnds[laneIndex] = Math.max(laneEnds[laneIndex], feature.end);
  });

  return lanes;
}

export function renderAnnotations(target, annotations, windowState, onJump, options = {}) {
  target.innerHTML = "";
  if (!annotations || annotations.length === 0) {
    target.textContent = "No annotations in this locus.";
    return;
  }

  const expanded = Boolean(options.expanded);
  const totalWidth = Math.max(windowState.end - windowState.start + 1, 1);
  const sorted = [...annotations].sort((left, right) => (
    left.start - right.start || left.end - right.end || String(left.label).localeCompare(String(right.label))
  ));
  const positioned = sorted.map((feature) => {
    const left = Math.max(feature.start, windowState.start);
    const right = Math.min(feature.end, windowState.end);
    const visibleWidth = Math.max(right - left + 1, 1);
    const offsetPercent = ((left - windowState.start) / totalWidth) * 100;
    const widthPercent = (visibleWidth / totalWidth) * 100;
    return {
      feature,
      left,
      right,
      visibleWidth,
      offsetPercent,
      widthPercent,
    };
  });
  const lanes = expanded
    ? packFeaturesIntoLanes(sorted, 20).map((lane) => lane.map((feature) => (
      positioned.find((entry) => entry.feature === feature)
    )).filter(Boolean))
    : [[...positioned].sort((left, right) => (
      right.visibleWidth - left.visibleWidth
      || left.feature.start - right.feature.start
      || left.feature.end - right.feature.end
    ))];
  const visibleFeatureCount = lanes.reduce((sum, lane) => sum + lane.length, 0);

  const shell = document.createElement("div");
  shell.className = `annotation-lane-shell${expanded ? " expanded" : " collapsed"}`;
  shell.style.height = `${Math.max(lanes.length, 1) * 24}px`;

  lanes.forEach((lane, laneIndex) => {
    lane.forEach((entry) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `annotation-chip${expanded ? "" : " collapsed"}`;
      chip.style.left = `${entry.offsetPercent}%`;
      chip.style.top = `${laneIndex * 24}px`;
      chip.style.width = `${Math.max(entry.widthPercent, 1)}%`;
      chip.title = `${entry.feature.label} | ${entry.feature.type} | ${entry.feature.start}-${entry.feature.end}`;
      chip.innerHTML = `
        <span class="annotation-chip-bar"></span>
        <span class="annotation-chip-label">${entry.feature.label}</span>
      `;
      chip.addEventListener("click", () => onJump(entry.feature));
      shell.appendChild(chip);
    });
  });

  target.appendChild(shell);

  if (expanded && visibleFeatureCount < annotations.length) {
    const note = document.createElement("div");
    note.className = "annotation-limit-note";
    note.textContent = `Showing ${visibleFeatureCount} of ${annotations.length} annotations (20-row cap).`;
    target.appendChild(note);
  } else if (!expanded && annotations.length > 1) {
    const note = document.createElement("div");
    note.className = "annotation-limit-note";
    note.textContent = `${annotations.length} annotations collapsed into one lane.`;
    target.appendChild(note);
  }
}

export function renderVariantList(target, variants, nearbyVariants, selectedVariant, onPick) {
  target.innerHTML = "";
  const inView = variants || [];
  const nearby = (nearbyVariants || []).filter(
    (candidate) => !inView.some((variant) => variant.id === candidate.id)
  );

  const renderRow = (variant, prefix = "") => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `variant-row${selectedVariant && selectedVariant.id === variant.id ? " active" : ""}`;
    row.innerHTML = `
      <p class="variant-title">${prefix}${variant.id}</p>
      <div class="variant-subtitle">${variant.contig}:${variant.position} ${variant.ref}→${variant.alt}</div>
    `;
    row.addEventListener("click", () => onPick(variant));
    target.appendChild(row);
  };

  if (!inView.length && !nearby.length) {
    target.textContent = "No variants in this locus.";
    return;
  }

  inView.forEach((variant) => renderRow(variant));
  nearby.forEach((variant, index) => {
    const prefix = index === 0 && (!inView.length || variant.position < inView[0]?.position) ? "Nearest: " : "Nearby: ";
    renderRow(variant, prefix);
  });
}

export function renderVariantDetail(target, variant) {
  if (!variant) {
    target.textContent = "Select a variant marker or row.";
    target.classList.add("muted");
    return;
  }

  target.classList.remove("muted");
  const quality = variant.qual === null ? "NA" : variant.qual;
  const effects = variant.effects || [];
  let effectRowsMarkup = "";
  effects.slice(0, 3).forEach((effect) => {
    const summary = effect.summary || {};
    effectRowsMarkup += `
      <div class="variant-effect-row">
        <span><strong>${summary.consequence || "NA"}</strong></span>
        <span>${summary.gene || "NA"}</span>
        <span>${summary.impact || "NA"}</span>
        <span>${summary.proteinChange || summary.codingChange || "NA"}</span>
      </div>
    `;
  });
  const effectMarkup = effects.length
    ? `
      <div class="variant-detail-section">
        <strong>${variant.effectSource || "Effect"} annotations</strong>
        <div class="variant-effect-list">
          ${effectRowsMarkup}
          ${effects.length > 3 ? `<div class="variant-effect-more">+${effects.length - 3} more annotations</div>` : ""}
        </div>
      </div>
    `
    : `
      <div class="variant-detail-section">
        <strong>Effect annotations</strong><br />
        <span class="muted">No ANN/CSQ annotations in this VCF record.</span>
      </div>
    `;
  target.innerHTML = `
    <strong>${variant.id}</strong><br />
    Position: ${variant.contig}:${variant.position}<br />
    Alleles: ${variant.ref}→${variant.alt}<br />
    Quality: ${quality}<br />
    Filter: ${variant.filter}<br />
    Format: ${variant.format || "NA"}<br />
    Sample: ${variant.sample || "NA"}<br />
    Info: ${variant.info}
    ${effectMarkup}
  `;
}

export function renderSummary(target, data) {
  target.innerHTML = "";
  const entries = [
    ["Contig", data.contig],
    ["Range", `${data.start}-${data.end}`],
    ["Width", `${data.end - data.start + 1} bp`],
    ["Reads", String(data.readCount)],
    ["Variants", String(data.variantCount)],
    ["Annotations", String(data.annotationCount)],
    ["Max Depth", String(data.maxDepth)],
  ];

  entries.forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    target.appendChild(dt);
    target.appendChild(dd);
  });
}
