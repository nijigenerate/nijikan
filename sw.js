const CACHE_NAME = "nijikan-static-v4";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/sw.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/webgl_backend/webgl_backend.js",
  "/wasm/nicxlive.js",
  "/wasm/nicxlive.wasm",
  "/tracking/tracking_runtime.js",
  "/tracking/face_tracking_worker.js",
  "/tracking/face_landmarker_v2_with_blendshapes.task",
  "/vendor/package/vision_bundle.cjs",
  "/vendor/package/wasm/vision_wasm_internal.js",
  "/vendor/package/wasm/vision_wasm_internal.wasm",
  "/vendor/package/wasm/vision_wasm_module_internal.js",
  "/vendor/package/wasm/vision_wasm_module_internal.wasm",
  "/vendor/package/wasm/vision_wasm_nosimd_internal.js",
  "/vendor/package/wasm/vision_wasm_nosimd_internal.wasm",
];

function isLocalDev() {
  const host = self.location.hostname;
  return host === "127.0.0.1" || host === "localhost";
}

self.addEventListener("install", (event) => {
  if (isLocalDev()) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const jobs = PRECACHE_URLS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: "reload" }));
      } catch (_) {}
    });
    await Promise.all(jobs);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => (key === CACHE_NAME ? Promise.resolve() : caches.delete(key))));
    await self.clients.claim();
  })());
});

function isStaticAssetPath(pathname) {
  if (pathname === "/" || pathname === "/index.html") return true;
  if (pathname === "/webgl_backend/webgl_backend.js") return true;
  if (pathname === "/wasm/nicxlive.js" || pathname === "/wasm/nicxlive.wasm") return true;
  if (pathname.startsWith("/icons/")) return true;
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs") || pathname.endsWith(".wasm") || pathname.endsWith(".css")) return true;
  if (pathname.endsWith(".webmanifest")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isLocalDev()) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put("/index.html", net.clone()).catch(() => {});
        return net;
      } catch (_) {
        const cached = await caches.match("/index.html", { ignoreSearch: true });
        if (cached) return cached;
        throw _;
      }
    })());
    return;
  }

  if (!isStaticAssetPath(url.pathname)) return;

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const net = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, net.clone()).catch(() => {});
      return net;
    } catch (_) {
      const fallback = await caches.match(url.pathname, { ignoreSearch: true });
      if (fallback) return fallback;
      throw _;
    }
  })());
});
