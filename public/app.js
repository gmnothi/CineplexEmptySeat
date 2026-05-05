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

let activeShowingId = null;
let showings = [];
let warmShowingsKey = "";
let warmShowingsPromise = null;
const openTheatres = new Set();

function todayLocal() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
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
  const date = dateEl.value || todayLocal();
  const theatres = theatresEl.value;
  const postalCode = postalCodeEl.value.trim();
  const params = new URLSearchParams({ date, theatres });
  if (postalCode) params.set("postalCode", postalCode);
  return params;
}

function warmShowings() {
  const params = currentParams();
  const key = params.toString();
  if (warmShowingsPromise && warmShowingsKey === key) return warmShowingsPromise;

  warmShowingsKey = key;
  warmShowingsPromise = fetch(`/api/showings?${params}`)
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load showings");
      return payload;
    })
    .catch((error) => {
      if (warmShowingsKey === key) {
        warmShowingsPromise = null;
      }
      throw error;
    });

  return warmShowingsPromise;
}

function scheduleWarmShowings() {
  window.clearTimeout(scheduleWarmShowings.timer);
  scheduleWarmShowings.timer = window.setTimeout(() => {
    warmShowings().catch(() => {});
  }, 250);
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
  showStatus("Loading Cineplex showtimes and seat counts...");
  refreshEl.disabled = true;
  searchButtonEl.disabled = true;

  try {
    const payload = await warmShowings();

    showings = payload.showings;
    openTheatres.clear();
    const theatreLabel = payload.theatreSource === "closest" ? "closest theatres" : "theatres";
    const radiusLabel = formatDistance(payload.maxDistanceKm);
    const radiusSuffix = radiusLabel ? ` (within ${radiusLabel})` : "";
    summaryEl.textContent = `${payload.showingCount} showings across ${payload.theatreCount} ${theatreLabel} near ${payload.location.label}${radiusSuffix}.`;
    showStatus(`${showings.filter((item) => item.occupied === 0).length} empty screenings found.`);
    renderShowings();
    activeShowingId = null;
    appEl.classList.remove("has-selection");
    emptyStateEl.classList.remove("hidden");
    seatDetailEl.classList.add("hidden");
  } catch (error) {
    showStatus(error.message);
  } finally {
    refreshEl.disabled = false;
    searchButtonEl.disabled = false;
  }
}

async function loadSeatmap(showing) {
  activeShowingId = showing.showtimeId;
  appEl.classList.add("has-selection");
  renderShowings();
  emptyStateEl.classList.add("hidden");
  seatDetailEl.classList.remove("hidden");
  detailTitleEl.textContent = showing.movie;
  detailMetaEl.textContent = `${showing.theatreName} · ${formatTime(showing.time)} · ${showing.experience}`;
  detailCountEl.textContent = `${showing.occupied} sold`;
  seatMapEl.textContent = "Loading seat map...";

  if (window.matchMedia("(max-width: 900px)").matches) {
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

dateEl.value = todayLocal();
warmShowings();
refreshEl.addEventListener("click", loadShowings);
document.querySelector("#filters").addEventListener("change", () => {
  scheduleWarmShowings();
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
postalCodeEl.addEventListener("input", scheduleWarmShowings);
