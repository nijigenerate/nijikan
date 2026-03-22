const CACHE_NAME = "nijikan-static-v7";
const APP_BASE_PATH = new URL("./", self.registration.scope).pathname;
const withBase = (path) => new URL(path, self.registration.scope).pathname;
const PRECACHE_URLS = [
  withBase("./"),
  withBase("./index.html"),
  withBase("./manifest.webmanifest"),
  withBase("./sw.js"),
  withBase("./icons/icon-192.png"),
  withBase("./icons/icon-512.png"),
  withBase("./webgl_backend/webgl_backend.js"),
  withBase("./wasm/nicxlive.js"),
  withBase("./wasm/nicxlive.wasm"),
  withBase("./tracking/tracking_runtime.js"),
  withBase("./tracking/face_tracking_worker.js"),
  withBase("./tracking/face_landmarker_v2_with_blendshapes.task"),
  withBase("./vendor/package/vision_bundle.cjs"),
  withBase("./vendor/package/wasm/vision_wasm_internal.js"),
  withBase("./vendor/package/wasm/vision_wasm_internal.wasm"),
  withBase("./vendor/package/wasm/vision_wasm_module_internal.js"),
  withBase("./vendor/package/wasm/vision_wasm_module_internal.wasm"),
  withBase("./vendor/package/wasm/vision_wasm_nosimd_internal.js"),
  withBase("./vendor/package/wasm/vision_wasm_nosimd_internal.wasm"),
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
  if (!pathname.startsWith(APP_BASE_PATH)) return false;
  if (pathname === APP_BASE_PATH || pathname === withBase("./index.html")) return true;
  if (pathname === withBase("./webgl_backend/webgl_backend.js")) return true;
  if (pathname === withBase("./wasm/nicxlive.js") || pathname === withBase("./wasm/nicxlive.wasm")) return true;
  if (pathname.startsWith(withBase("./icons/"))) return true;
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
        cache.put(withBase("./index.html"), net.clone()).catch(() => {});
        return net;
      } catch (_) {
        const cached = await caches.match(withBase("./index.html"), { ignoreSearch: true });
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
