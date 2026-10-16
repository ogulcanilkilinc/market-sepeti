// Önce internetten dener (güncellemeler hemen gelsin), internet yoksa son kaydedilen sürümü gösterir.
// Ayrıca uygulama kapalıyken günde ~1 kez takip edilen ürünlerin fiyatına bakıp bildirim gösterir.
importScripts("common.js"); // MARKETS, loadAlerts, saveAlerts, notifyNewHits, STATE_CACHE

const CACHE = "market-sepeti-v4";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys()
    // Takip listesi (STATE_CACHE) silinmesin, sadece eski dosya önbellekleri temizlensin.
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== STATE_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: tarayıcı önbelleğindeki eski dosyayı kullanma, sunucuya "değişti mi?" diye sor (değişmediyse 304, ucuz).
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true, cacheName: CACHE }))
  );
});

// Chrome, yüklü uygulamada bu olayı günde yaklaşık bir kez tetikler (app.js: setupBackgroundCheck).
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "fiyat-kontrol") e.waitUntil(checkPrices());
});

async function checkPrices() {
  const alerts = await loadAlerts();
  if (!alerts.length) return;
  const data = await (await fetch("data/products.json", { cache: "no-cache" })).json();
  if (await notifyNewHits(self.registration, alerts, data.sources)) await saveAlerts(alerts);
}

// Bildirime dokununca uygulamayı Takip sekmesinde aç.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) {
      wins[0].postMessage({ tab: "takip" });
      return wins[0].focus();
    }
    return self.clients.openWindow(e.notification.data?.url || "./?tab=takip");
  })());
});
