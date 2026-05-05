const showingsEl = document.querySelector("#showings");
const statusEl = document.querySelector("#status");
const summaryEl = document.querySelector("#summary");
const appEl = document.querySelector(".app");
const sidebarEl = document.querySelector(".sidebar");
const postalCodeEl = document.querySelector("#postalCode");
const dateEl = document.querySelector("#date");
const theatresEl = document.querySelector("#theatres");
const refreshEl = document.querySelector("#refresh");
const searchButtonEl = document.querySelector("#searchButton");
const emptyStateEl = document.querySelector("#emptyState");
const seatDetailEl = document.querySelector("#seatDetail");
const detailTitleEl = document.querySelector("#detailTitle");
const detailMetaEl = document.querySelector("#detailMeta");
const detailCountEl = document.querySelector("#detailCount");
const seatMapEl = document.querySelector("#seatMap");
const detailHomeEl = seatDetailEl.parentElement;
const mobileQuery = window.matchMedia("(max-width: 900px)");

let activeShowingId = null;
let showings = [];
let activeAbort = null;
let lastMeta = null;
const openTheatres = new Set();

function todayToronto() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function groupedByTheatre(items) {
  return items.reduce((groups, item) => {
    if (!groups.has(item.theatreName)) {
      groups.set(item.theatreName, { distanceKm: item.distanceKm, rows: [] });
    }
    groups.get(item.theatreName).rows.push(item);
    return groups;
  }, new Map());
}

function formatDistance(km) {
  if (typeof km !== "number" || !Number.isFinite(km)) return "";
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function showStatus(message) {
  statusEl.textContent = message;
}

function currentParams() {
  const date = dateEl.value || todayToronto();
  const theatres = theatresEl.value;
  const postalCode = postalCodeEl.value.trim();
  const params = new URLSearchParams({ date, theatres });
  if (postalCode) params.set("postalCode", postalCode);
  return params;
}

function buildSummary(meta, showingCount) {
  if (!meta) return "";
  const radiusLabel = formatDistance(meta.maxDistanceKm);
  const radiusSuffix = radiusLabel ? ` (within ${radiusLabel})` : "";
  const theatreLabel = meta.theatreSource === "closest" ? "closest theatres" : "theatres";
  const count = typeof showingCount === "number" ? showingCount : meta.theatreCount;
  if (typeof showingCount === "number") {
    return `${count} showings across ${meta.theatreCount} ${theatreLabel} near ${meta.location.label}${radiusSuffix}.`;
  }
  return `Loading ${meta.theatreCount} ${theatreLabel} near ${meta.location.label}${radiusSuffix}…`;
}

function sortShowings(items) {
  return items.sort((a, b) =>
    (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)
    || a.theatreName.localeCompare(b.theatreName)
    || a.occupied - b.occupied
    || new Date(a.time) - new Date(b.time)
  );
}

function placeDetailPanel() {
  const isMobile = mobileQuery.matches;
  const isShown = !seatDetailEl.classList.contains("hidden");
  if (isMobile && isShown && activeShowingId) {
    const activeBtn = showingsEl.querySelector(
      `[data-showtime-id="${CSS.escape(activeShowingId)}"]`,
    );
    if (activeBtn) {
      activeBtn.before(seatDetailEl);
      return;
    }
  }
  if (seatDetailEl.parentElement !== detailHomeEl) {
    detailHomeEl.append(seatDetailEl);
  }
}

function renderShowings() {
  showingsEl.textContent = "";
  showingsEl.classList.remove("ready");
  const groups = groupedByTheatre(showings);
  let index = 0;

  for (const [theatre, group] of groups) {
    const { rows, distanceKm } = group;
    const isOpen = openTheatres.has(theatre);
    const heading = document.createElement("button");
    heading.className = "theatre";
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(isOpen));
    const distanceLabel = formatDistance(distanceKm);
    const meta = distanceLabel
      ? `${rows.length} showings · ${distanceLabel}`
      : `${rows.length} showings`;
    heading.innerHTML = `
      <span>${escapeHtml(theatre)}</span>
      <span>${escapeHtml(meta)}</span>
    `;
    heading.addEventListener("click", () => {
      if (openTheatres.has(theatre)) openTheatres.delete(theatre);
      else openTheatres.add(theatre);
      renderShowings();
    });
    heading.style.animationDelay = `${Math.min(index * 35, 280)}ms`;
    showingsEl.append(heading);
    index += 1;

    if (!isOpen) continue;

    for (const showing of rows) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `showing${showing.occupied === 0 ? " empty" : ""}${showing.showtimeId === activeShowingId ? " active" : ""}`;
      row.dataset.theatreId = showing.theatreId;
      row.dataset.showtimeId = showing.showtimeId;

      row.innerHTML = `
        <span class="time">${formatTime(showing.time)}</span>
        <span class="count">${showing.occupied} sold</span>
        <span class="movie">
          <strong>${escapeHtml(showing.movie)}</strong>
          <span>${escapeHtml(showing.experience)} · ${showing.available} available</span>
        </span>
      `;
      row.addEventListener("click", () => loadSeatmap(showing));
      row.style.animationDelay = `${Math.min(index * 25, 320)}ms`;
      showingsEl.append(row);
      index += 1;
    }
  }

  placeDetailPanel();
  requestAnimationFrame(() => showingsEl.classList.add("ready"));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function moveSearchToRail() {
  if (appEl.classList.contains("searched")) return;

  const first = sidebarEl.getBoundingClientRect();
  appEl.classList.remove("intro");
  appEl.classList.add("searched");
  const last = sidebarEl.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const scaleX = first.width / last.width;
  const scaleY = first.height / last.height;

  sidebarEl.animate(
    [
      {
        transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`,
        borderRadius: "28px",
      },
      {
        transform: "translate(0, 0) scale(1)",
        borderRadius: "0",
      },
    ],
    {
      duration: 780,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    },
  );
}

async function loadShowings() {
  moveSearchToRail();
  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();
  const myAbort = activeAbort;

  showings = [];
  openTheatres.clear();
  activeShowingId = null;
  lastMeta = null;
  appEl.classList.remove("has-selection");
  emptyStateEl.classList.remove("hidden");
  seatDetailEl.classList.add("hidden");
  showingsEl.textContent = "";

  showStatus("Loading Cineplex showtimes and seat counts…");
  refreshEl.disabled = true;
  searchButtonEl.disabled = true;

  let theatresReceived = 0;

  const handleEvent = (event) => {
    if (event.type === "meta") {
      lastMeta = event;
      summaryEl.textContent = buildSummary(event);
    } else if (event.type === "theatre") {
      theatresReceived += 1;
      showings = sortShowings([...showings, ...event.showings]);
      const empties = showings.filter((s) => s.occupied === 0).length;
      const total = lastMeta ? lastMeta.theatreCount : theatresReceived;
      showStatus(`${theatresReceived}/${total} theatres · ${empties} empty so far`);
      renderShowings();
    } else if (event.type === "theatreError") {
      theatresReceived += 1;
    } else if (event.type === "done") {
      summaryEl.textContent = buildSummary(lastMeta, event.showingCount);
      const empties = showings.filter((s) => s.occupied === 0).length;
      showStatus(`${empties} empty screenings found.`);
    } else if (event.type === "error") {
      showStatus(event.error);
    }
  };

  try {
    const response = await fetch(`/api/showings?${currentParams()}`, { signal: myAbort.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Unable to load showings (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) handleEvent(JSON.parse(line));
      }
    }
    const tail = buffer.trim();
    if (tail) handleEvent(JSON.parse(tail));
  } catch (error) {
    if (error.name !== "AbortError") {
      showStatus(error.message);
    }
  } finally {
    if (activeAbort === myAbort) activeAbort = null;
    refreshEl.disabled = false;
    searchButtonEl.disabled = false;
  }
}

async function loadSeatmap(showing) {
  activeShowingId = showing.showtimeId;
  appEl.classList.add("has-selection");
  emptyStateEl.classList.add("hidden");
  seatDetailEl.classList.remove("hidden");
  renderShowings();
  detailTitleEl.textContent = showing.movie;
  detailMetaEl.textContent = `${showing.theatreName} · ${formatTime(showing.time)} · ${showing.experience}`;
  detailCountEl.textContent = `${showing.occupied} sold`;
  seatMapEl.textContent = "Loading seat map...";

  if (mobileQuery.matches) {
    requestAnimationFrame(() => {
      seatDetailEl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  try {
    const response = await fetch(`/api/seatmap?theatreId=${showing.theatreId}&showtimeId=${showing.showtimeId}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to load seat map");
    renderSeatmap(payload);
  } catch (error) {
    seatMapEl.textContent = error.message;
  }
}

function renderSeatmap(payload) {
  const seats = payload.seats || [];
  const availability = payload.availability || {};
  const maxColumn = Math.max(...seats.map((seat) => seat.column), 1);
  const maxRow = Math.max(...seats.map((seat) => seat.number), 1);
  const byPosition = new Map(seats.map((seat) => [`${seat.number}:${seat.column}`, seat]));

  const grid = document.createElement("div");
  grid.className = "seat-grid";
  grid.style.setProperty("--cols", maxColumn);
  grid.style.setProperty("--rows", maxRow);

  for (let row = 1; row <= maxRow; row += 1) {
    for (let column = 1; column <= maxColumn; column += 1) {
      const seat = byPosition.get(`${row}:${column}`);
      const dot = document.createElement("span");
      if (!seat) {
        dot.className = "seat blank";
      } else {
        const state = availability[seat.id];
        dot.className = `seat ${state === "Occupied" ? "occupied" : state === "Broken" ? "broken" : "available"}`;
        dot.title = `${seat.label || seat.id}: ${state || "Unknown"}`;
      }
      grid.append(dot);
    }
  }

  seatMapEl.textContent = "";
  seatMapEl.append(grid);
}

{
  const today = todayToronto();
  dateEl.min = today;
  if (!dateEl.value || dateEl.value < today) dateEl.value = today;
}
refreshEl.addEventListener("click", loadShowings);
document.querySelector("#filters").addEventListener("change", () => {
  if (appEl.classList.contains("searched")) loadShowings();
});
document.querySelector("#filters").addEventListener("submit", (event) => {
  event.preventDefault();
  loadShowings();
});
postalCodeEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadShowings();
  }
});
mobileQuery.addEventListener("change", placeDetailPanel);
