const FILE_CACHE = "file-cache";
const APP_CACHE  = "app-v1";

// Derive base from SW scope so this works at "/" and "/repo-name/"
const SCOPE = self.registration.scope;          // e.g. "https://user.github.io/repo/"
const BASE  = new URL(SCOPE).pathname;          // e.g. "/" or "/repo-name/"

// ── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  // Precache the app shell so the first offline visit works
  event.waitUntil(
    caches.open(APP_CACHE).then((c) => c.addAll([SCOPE, SCOPE + "index.html", SCOPE + "manifest.webmanifest"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      // Delete outdated app cache versions (keep file-cache untouched)
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("app-") && k !== APP_CACHE)
            .map((k) => caches.delete(k))
        )
      ),
    ])
  );
});

// ── Fetch router ─────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Uploaded files — stream from file cache with Range support.
  // Use includes() so it matches even when a base path prefix is present
  // (e.g. /repo-name/_files/… when deployed to a GitHub Pages project page).
  if (url.pathname.includes("/_files/")) {
    event.respondWith(serveFile(event.request));
    return;
  }

  // Skip cross-origin requests (fonts, analytics, etc.)
  if (url.origin !== self.location.origin) return;

  // Hashed JS/CSS assets — cache-first (content hash = immutable)
  if (url.pathname.startsWith(BASE + "assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) => cached ?? fetchAndCache(event.request, APP_CACHE)
      )
    );
    return;
  }

  // HTML navigation — network-first so the SPA stays fresh, fallback to shell
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetchAndCache(event.request, APP_CACHE).catch(
        () => caches.match(SCOPE + "index.html") ?? caches.match(SCOPE)
      )
    );
    return;
  }

  // Everything else (sw.js itself, icons, etc.) — network-first with cache fallback
  event.respondWith(
    fetchAndCache(event.request, APP_CACHE).catch(
      () => caches.match(event.request)
    )
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchAndCache(request, cacheName) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function serveFile(request) {
  const { pathname } = new URL(request.url);
  // Extract the file ID from wherever /_files/ appears in the path so this
  // works both at root (/_files/id) and under a base path (/repo-name/_files/id).
  const fileId = pathname.split("/_files/")[1];
  const cache  = await caches.open(FILE_CACHE);
  const cached = await cache.match("/_files/" + fileId);
  if (!cached) return new Response("Not found", { status: 404 });

  const contentType = cached.headers.get("content-type") || "application/octet-stream";
  const totalSize   = Number(cached.headers.get("x-size") || 0);
  const rangeHeader = request.headers.get("Range");

  // No Range — stream body directly (zero memory copy in main thread)
  if (!rangeHeader) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(totalSize),
        "Accept-Ranges": "bytes",
      },
    });
  }

  // Range request (video seeking) — slice the requested bytes
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) return new Response("Range not satisfiable", { status: 416 });

  const start = parseInt(match[1], 10);
  const end   = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  // blob.slice() is a lazy view — avoids loading the full file into RAM for each Range request.
  const blob  = await cached.blob();
  const chunk = blob.slice(start, end + 1);

  return new Response(chunk, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Content-Length": String(chunk.size),
      "Accept-Ranges": "bytes",
    },
  });
}
