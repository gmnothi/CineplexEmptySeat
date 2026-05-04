import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = parseInteger(process.env.PORT, 4173);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const API_KEY = process.env.CINEPLEX_API_KEY || "dcdac5601d864addbc2675a2e96cb1f8";
const THEATRICAL_API = "https://apis.cineplex.com/prod/cpx/theatrical/api";
const TICKETING_API = "https://apis.cineplex.com/prod/ticketing/api";
const DEFAULT_LAT = parseNumber(process.env.DEFAULT_LAT, 43.6532);
const DEFAULT_LNG = parseNumber(process.env.DEFAULT_LNG, -79.3832);
const DEFAULT_LOCATION_LABEL = "Toronto";
const MAX_THEATRES = parseInteger(process.env.MAX_THEATRES, 24);
const DEFAULT_THEATRES = parseInteger(process.env.DEFAULT_THEATRES, 12);
const SHOWTIME_FETCH_CONCURRENCY = parseInteger(process.env.SHOWTIME_FETCH_CONCURRENCY, 4);
const API_RATE_LIMIT = parseInteger(process.env.API_RATE_LIMIT, 45);
const API_RATE_WINDOW_MS = parseInteger(process.env.API_RATE_WINDOW_MS, 60_000);
const FETCH_TIMEOUT_MS = parseInteger(process.env.FETCH_TIMEOUT_MS, 12_000);
const UPSTREAM_CACHE_TTL_MS = parseInteger(process.env.UPSTREAM_CACHE_TTL_MS, 180_000);
const COMPUTED_CACHE_TTL_MS = parseInteger(process.env.COMPUTED_CACHE_TTL_MS, 90_000);
const CACHE_MAX_ENTRIES = parseInteger(process.env.CACHE_MAX_ENTRIES, 1_200);
const APP_USER_AGENT = process.env.APP_USER_AGENT || "EmptyScreens/1.0";

const cache = new Map();
const inFlight = new Map();
const rateLimits = new Map();

class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function todayToronto() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    ...extra,
  };
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, securityHeaders({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  }));
  res.end(JSON.stringify(payload));
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value, ttlMs) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

async function fetchJson(url, { headers = {}, cacheKey = url, ttlMs = UPSTREAM_CACHE_TTL_MS } = {}) {
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("Upstream returned invalid JSON");
    }

    return setCached(cacheKey, parsed, ttlMs);
  })();

  inFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function cineplexJson(url) {
  return fetchJson(url, {
    headers: { "Ocp-Apim-Subscription-Key": API_KEY },
    ttlMs: UPSTREAM_CACHE_TTL_MS,
  });
}

async function publicJson(url, headers = {}) {
  return fetchJson(url, {
    headers,
    ttlMs: UPSTREAM_CACHE_TTL_MS * 6,
  });
}

function normalizePostalCode(value) {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) {
    return `${compact.slice(0, 3)} ${compact.slice(3)}`;
  }
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function getValidatedDate(url) {
  const date = url.searchParams.get("date") || todayToronto();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ClientError("Date must be in YYYY-MM-DD format");
  }
  return date;
}

function getTheatreLimit(url) {
  const requested = parseInteger(url.searchParams.get("theatres"), DEFAULT_THEATRES);
  return Math.min(Math.max(requested, 1), MAX_THEATRES);
}

function validateCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new ClientError("Invalid latitude or longitude");
  }
}

function validateId(value, label) {
  if (!value || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new ClientError(`Invalid ${label}`);
  }
}

async function resolveLocation(url) {
  const postalCode = normalizePostalCode(url.searchParams.get("postalCode") || "");
  if (!postalCode) {
    const lat = Number(url.searchParams.get("lat") || DEFAULT_LAT);
    const lng = Number(url.searchParams.get("lng") || DEFAULT_LNG);
    validateCoordinates(lat, lng);
    return {
      lat,
      lng,
      label: DEFAULT_LOCATION_LABEL,
      postalCode: "",
    };
  }

  if (!/^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(postalCode)) {
    throw new ClientError("Postal code must be a Canadian postal code");
  }

  const results = await publicJson(
    `https://nominatim.openstreetmap.org/search?format=json&countrycodes=ca&limit=1&q=${encodeURIComponent(postalCode)}`,
    { "User-Agent": APP_USER_AGENT },
  );
  let match = results[0];

  if (!match) {
    const fsa = postalCode.replace(/\s/g, "").slice(0, 3);
    const fsaPayload = await publicJson(`https://api.zippopotam.us/ca/${encodeURIComponent(fsa)}`);
    const place = fsaPayload.places?.[0];
    if (place) {
      match = {
        lat: place.latitude,
        lon: place.longitude,
      };
    }
  }

  if (!match) {
    throw new ClientError(`Could not find coordinates for postal code ${postalCode}`, 404);
  }

  const lat = Number(match.lat);
  const lng = Number(match.lon);
  validateCoordinates(lat, lng);

  return {
    lat,
    lng,
    label: postalCode,
    postalCode,
  };
}

function flattenSeats(layout) {
  const seats = [];
  for (const area of ["standardSeats", "dboxSeats", "balconySeats"]) {
    const block = layout?.[area];
    for (const row of block?.rows || []) {
      for (const seat of row.seats || []) {
        seats.push({ ...seat, area, number: row.number, rowLabel: row.label });
      }
    }
  }
  return seats;
}

function flattenShowtimes(payload, fallbackTheatre) {
  const roots = Array.isArray(payload) ? payload : [payload];
  const showings = [];

  for (const root of roots) {
    for (const date of root.dates || []) {
      for (const movie of date.movies || []) {
        for (const experience of movie.experiences || []) {
          for (const session of experience.sessions || []) {
            if (!session.isReservedSeating || !session.isShowtimeEnabledOnline || session.isSoldOut) {
              continue;
            }
            if (!session.vistaSessionId) continue;
            showings.push({
              theatreId: root.theatreId || fallbackTheatre.theatreId,
              theatreName: root.theatre || fallbackTheatre.theatreName,
              distanceKm: fallbackTheatre.distanceKm,
              movie: movie.name,
              time: session.showStartDateTime,
              showtimeId: session.vistaSessionId,
              seatsRemaining: session.seatsRemaining,
              experience: (experience.experienceTypes || []).join(" / ") || "Regular",
            });
          }
        }
      }
    }
  }

  return showings;
}

function distanceMeters(theatre) {
  const distance = theatre.location?.distanceToOriginInMeters;
  return typeof distance === "number" ? distance : Number.POSITIVE_INFINITY;
}

function selectTheatres(payload, limit) {
  const seen = new Set();
  const combined = [];
  for (const list of [payload.nearbyTheatres || [], payload.otherTheatres || []]) {
    for (const theatre of list) {
      if (!theatre.theatreId || seen.has(theatre.theatreId)) continue;
      seen.add(theatre.theatreId);
      combined.push(theatre);
    }
  }
  combined.sort((a, b) => distanceMeters(a) - distanceMeters(b));
  const chosen = combined.slice(0, limit);
  const nearbyIds = new Set((payload.nearbyTheatres || []).map((t) => t.theatreId));
  const usedFromOther = chosen.some((t) => !nearbyIds.has(t.theatreId));
  return {
    theatres: chosen.map((t) => {
      const meters = distanceMeters(t);
      return {
        ...t,
        distanceKm: Number.isFinite(meters) ? Math.round(meters / 100) / 10 : null,
      };
    }),
    source: usedFromOther ? "closest" : "nearby",
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await mapper(items[current]);
      } catch (error) {
        results[current] = { ...items[current], error: error.message };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function getSeatCounts(showing) {
  const [layout, availability] = await Promise.all([
    cineplexJson(`${TICKETING_API}/v1/theatre/${showing.theatreId}/showtime/${showing.showtimeId}/seat-layout`),
    cineplexJson(`${TICKETING_API}/v1/theatre/${showing.theatreId}/showtime/${showing.showtimeId}/seat-availability?preview=true`),
  ]);

  const seats = flattenSeats(layout);
  const statuses = availability.seatAvailabilities || {};
  const counts = { available: 0, occupied: 0, broken: 0, other: 0 };

  for (const seat of seats) {
    const status = statuses[seat.id];
    if (status === "Available") counts.available += 1;
    else if (status === "Occupied") counts.occupied += 1;
    else if (status === "Broken") counts.broken += 1;
    else counts.other += 1;
  }

  return {
    ...showing,
    totalSeats: seats.length,
    available: counts.available,
    occupied: counts.occupied,
    broken: counts.broken,
  };
}

async function handleShowings(req, res, url) {
  const location = await resolveLocation(url);
  const date = getValidatedDate(url);
  const theatreLimit = getTheatreLimit(url);
  const cacheKey = `showings:${location.lat.toFixed(4)}:${location.lng.toFixed(4)}:${date}:${theatreLimit}`;
  const cached = getCached(cacheKey);
  if (cached) {
    json(res, 200, cached, { "x-cache": "HIT" });
    return;
  }

  const theatresPayload = await cineplexJson(
    `${THEATRICAL_API}/v1/theatres?language=en&latitude=${location.lat}&longitude=${location.lng}`,
  );
  const { theatres, source: theatreSource } = selectTheatres(theatresPayload, theatreLimit);
  const maxDistanceKm = theatres.reduce(
    (max, t) => (typeof t.distanceKm === "number" && t.distanceKm > max ? t.distanceKm : max),
    0,
  );

  const showtimeArrays = await mapLimit(theatres, SHOWTIME_FETCH_CONCURRENCY, async (theatre) => {
    try {
      const showtimes = await cineplexJson(
        `${THEATRICAL_API}/v1/showtimes?language=en&locationId=${theatre.theatreId}&date=${date}`,
      );
      return flattenShowtimes(showtimes, theatre);
    } catch {
      return [];
    }
  });
  const candidates = showtimeArrays.flatMap((entry) => (Array.isArray(entry) ? entry : []));

  const counted = await mapLimit(candidates, 5, getSeatCounts);
  const showings = counted
    .filter((showing) => !showing.error)
    .sort((a, b) => a.occupied - b.occupied || new Date(a.time) - new Date(b.time));

  const payload = {
    date,
    location,
    theatreSource,
    theatreCount: theatres.length,
    maxDistanceKm: maxDistanceKm > 0 ? maxDistanceKm : null,
    showingCount: showings.length,
    showings,
    errors: IS_PRODUCTION
      ? counted.filter((showing) => showing.error).length
      : counted.filter((showing) => showing.error),
  };

  json(res, 200, setCached(cacheKey, payload, COMPUTED_CACHE_TTL_MS), { "x-cache": "MISS" });
}

async function handleSeatmap(req, res, url) {
  const theatreId = url.searchParams.get("theatreId");
  const showtimeId = url.searchParams.get("showtimeId");
  validateId(theatreId, "theatreId");
  validateId(showtimeId, "showtimeId");

  const [layout, availability] = await Promise.all([
    cineplexJson(`${TICKETING_API}/v1/theatre/${theatreId}/showtime/${showtimeId}/seat-layout`),
    cineplexJson(`${TICKETING_API}/v1/theatre/${theatreId}/showtime/${showtimeId}/seat-availability?preview=true`),
  ]);

  json(res, 200, {
    layout,
    availability: availability.seatAvailabilities || {},
    seats: flattenSeats(layout),
  });
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
  const key = clientIp(req);
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + API_RATE_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > API_RATE_LIMIT;
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}

async function serveStatic(req, res, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("Bad request");
    return;
  }

  const safePath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };

  try {
    const data = await readFile(filePath);
    const isHtml = ext === ".html";
    const hasVersion = req.url.includes("?v=");
    res.writeHead(200, securityHeaders({
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": isHtml
        ? "no-cache"
        : hasVersion
          ? "public, max-age=31536000, immutable"
          : "public, max-age=300",
    }));
    if (req.method === "HEAD") res.end();
    else res.end(data);
  } catch {
    res.writeHead(404, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method || "")) {
      json(res, 405, { error: "Method not allowed" }, { allow: "GET, HEAD" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname.startsWith("/api/") && isRateLimited(req)) {
      json(res, 429, { error: "Too many requests" });
      return;
    }

    if (url.pathname === "/api/showings") {
      await handleShowings(req, res, url);
      return;
    }
    if (url.pathname === "/api/seatmap") {
      await handleSeatmap(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(res, 404, { error: "Not found" });
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    const status = error instanceof ClientError ? error.status : 502;
    const message = error instanceof ClientError
      ? error.message
      : IS_PRODUCTION
        ? "Upstream service unavailable"
        : error.message;
    json(res, status, { error: message });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, () => {
  console.log(`Empty Screens running at http://localhost:${PORT}`);
});

setInterval(cleanupRateLimits, API_RATE_WINDOW_MS).unref();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
