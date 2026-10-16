"use strict";
// Uygulama (app.js) ve arka planda çalışan service worker (sw.js) birlikte kullanır.

const MARKETS = {
  a101:        { name: "A101",        color: "#0099d8" },
  bim:         { name: "BİM",         color: "#d7141a" },
  sok:         { name: "Şok",         color: "#e0a800", text: "#1c1c1c" },
  migros:      { name: "Migros",      color: "#f07d00" },
  carrefour:   { name: "CarrefourSA", color: "#1e4fa0" },
  tarim_kredi: { name: "Tarım Kredi", color: "#2e7d32" },
  yunus:       { name: "Yunus",       color: "#6a1b9a" },
};

const tl = (n) => n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₺";

/** "Süt", "SUT", "süt" -> "sut". Türkçe harfleri sadeleştirir. */
function norm(s) {
  return String(s).toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Ad + gramajdan sıralamasız anahtar: "Pınar Organik Süt 1 Lt" ile "PINAR SUT ORGANIK 1 LT" aynı çıkar. */
const UNIT_ALIAS = { l: "lt", litre: "lt", gr: "g", gram: "g" };
const nameKey = (n) => [...new Set(norm(n).split(" ").map((w) => UNIT_ALIAS[w] || w))].sort().join(" ");

// ─── Fiyat takibi ──────────────────────────────────────────────────────
// Takip listesi Cache Storage'da tutulur; çünkü service worker localStorage'a erişemez.
const STATE_CACHE = "market-sepeti-state";
const ALERTS_KEY = "takip-listesi.json";

async function loadAlerts() {
  try {
    const r = await (await caches.open(STATE_CACHE)).match(ALERTS_KEY);
    return r ? await r.json() : [];
  } catch { return []; }
}

async function saveAlerts(alerts) {
  const c = await caches.open(STATE_CACHE);
  await c.put(ALERTS_KEY, new Response(JSON.stringify(alerts), { headers: { "Content-Type": "application/json" } }));
}

const UNIT_WORDS = new Set(["lt", "g", "kg", "ml", "cl", "adet", "x", "li", "lu"]);

/**
 * Her takip için tüm marketlerdeki ve BİM aktüeldeki en ucuz teklifi bulur.
 * Aynı ürün (aynı ad + gramaj) her markette aranır; aktüelde ise ürün adındaki
 * kelimelerin hepsi geçiyorsa (ör. "Sek Süt" -> "Sek Süt 6x1 Lt") sayılır.
 */
function checkAlerts(alerts, sources) {
  const all = Object.values(sources).flat();
  const byKey = new Map();
  for (const it of all) {
    const k = nameKey(it.n);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }
  const aktuel = all.filter((it) => it.d).map((it) => [it, new Set(nameKey(it.n).split(" "))]);

  return alerts.map((a) => {
    const offers = [];
    const add = (it) => { for (const [m, price] of it.p) offers.push({ m, price, n: it.n, d: it.d || null }); };
    (byKey.get(a.key) || []).forEach(add);
    const words = a.key.split(" ").filter((w) => !/^\d/.test(w) && !UNIT_WORDS.has(w));
    if (words.length) for (const [it, set] of aktuel) if (!byKey.get(a.key)?.includes(it) && words.every((w) => set.has(w))) add(it);
    offers.sort((x, y) => x.price - y.price);
    const best = offers[0] || null;
    return { alert: a, best, hit: !!best && best.price <= a.target };
  });
}

/** Hedef fiyata inen ve daha önce aynı fiyatla bildirilmemiş ürünler için bildirim gösterir. */
async function notifyNewHits(registration, alerts, sources) {
  let changed = false;
  for (const { alert: a, best, hit } of checkAlerts(alerts, sources)) {
    if (!hit) {
      // İndirim bitti: bir dahaki indirimde yeniden haber verilsin.
      if (a.notified) { delete a.notified; changed = true; }
      continue;
    }
    if (a.notified && best.price >= a.notified.price) continue; // bu fiyatı (ya da daha ucuzunu) zaten bildirdik
    const where = best.d ? `BİM aktüel (${best.d})` : MARKETS[best.m].name;
    try {
      await registration.showNotification(`🔔 ${a.n} indirimde!`, {
        body: `${where}: ${tl(best.price)} (senin hedefin ${tl(a.target)})${best.d ? "\n" + best.n : ""}`,
        icon: "icons/icon-192.png",
        tag: "takip-" + a.id,
        data: { url: "./?tab=takip" },
      });
    } catch { continue; } // izin yoksa sessizce geç; Takip sekmesinde yine görünür
    a.notified = { price: best.price, m: best.m, d: best.d };
    changed = true;
  }
  return changed;
}
