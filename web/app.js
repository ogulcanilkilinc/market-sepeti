"use strict";
// MARKETS, tl, norm, nameKey ve fiyat takibi fonksiyonları common.js içinde.

const SUGGESTIONS = [["🥛", "Süt"], ["🍞", "Ekmek"], ["🥚", "Yumurta"], ["🧀", "Beyaz peynir"], ["🥣", "Yoğurt"],
  ["🍅", "Domates"], ["🥔", "Patates"], ["🧅", "Soğan"], ["🌻", "Ayçiçek yağı"], ["🫒", "Zeytinyağı"], ["🍵", "Çay"],
  ["🍬", "Şeker"], ["🌾", "Un"], ["🍚", "Pirinç"], ["🍝", "Makarna"], ["🍗", "Tavuk"], ["🥩", "Kıyma"], ["🧴", "Deterjan"]];
const PAGE = 30;
const AKTUEL_MARKETS = ["bim", "a101", "yunus"]; // aktüel ürünleri olan marketler (Aktüel sekmesindeki sıra)

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const unitValue = (u) => { const m = u && u.match(/([\d.]+,\d+)/); return m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : Infinity; };

// ─── Veri ──────────────────────────────────────────────────────────────
let items = [];
let sources = null; // ham kaynaklar (fiyat takibi kontrolü için)
let alerts = [];    // fiyat takibi listesi (common.js: loadAlerts/saveAlerts)
let brochures = []; // Çağdaş, Anadolu Tat, Şok, Yunus broşürleri; sayfa metinleri (texts: PDF metni ya da OCR) ile aranır

async function loadBrochures() {
  try {
    const data = await (await fetch("data/brochures.json", { cache: "no-cache" })).json();
    brochures = data.brochures.map((b) => ({ ...b, pw: (b.texts || []).map((t) => norm(t).split(" ")) }));
  } catch { brochures = []; }
}

async function loadData() {
  const brochuresReady = loadBrochures();
  try {
    const res = await fetch("data/products.json", { cache: "no-cache" });
    const data = await res.json();
    mergeYunus(data.sources);
    sources = data.sources;
    items = Object.values(data.sources).flat().map((it) => ({
      ...it,
      w: norm(it.n).split(" "),
      cw: norm(it.c).split(" ").filter(Boolean),
      u: unitValue(it.p[0][2]),
    }));
    const fmt = (s, opts) => new Date(s).toLocaleString("tr-TR", { day: "numeric", month: "long", ...opts });
    let text = "Fiyatlar " + fmt(data.updated, { hour: "2-digit", minute: "2-digit" }) + " itibarıyla";
    // Yunus evdeki bilgisayardan gelir; eski kaldıysa belirt.
    const y = data.stamps?.yunus;
    if (y && y.slice(0, 10) !== data.updated.slice(0, 10)) text += ` (Yunus: ${fmt(y)})`;
    $("#updated").textContent = text;
    refreshCartPrices();
  } catch (e) {
    $("#updated").textContent = "Fiyatlar yüklenemedi. İnternet bağlantını kontrol et.";
  }
  await brochuresReady;
  alerts = await loadAlerts();
  refreshBells();
  if (alerts.length) await setupBackgroundCheck();
  await updateTakip(true);
  const startTab = new URLSearchParams(location.search).get("tab");
  if (startTab) showTab(startTab);
  if ($("#q").value) search();
  if ($("#tab-aktuel").classList.contains("active")) renderAktuel(true);
}

/** Yunus ürünü diğer marketlerde birebir aynı adla varsa, Yunus fiyatını o ürünün kartına ekler. */
function mergeYunus(sources) {
  if (!sources.mf || !sources.yunus) return;
  const byKey = new Map();
  for (const it of sources.mf) {
    const k = nameKey(it.n);
    byKey.set(k, byKey.has(k) ? null : it); // aynı ada sahip birden çok ürün varsa eşleştirme
  }
  sources.yunus = sources.yunus.filter((y) => {
    const it = byKey.get(nameKey(y.n));
    if (!it || it.p.some((o) => o[0] === "yunus")) return true;
    it.p.push(y.p[0]);
    it.p.sort((a, b) => a[1] - b[1]);
    return false;
  });
}

/** Sepetteki fiyatları bugünün fiyatlarıyla günceller (ürün bulunamazsa eski fiyat kalır). */
function refreshCartPrices() {
  const now = new Map();
  for (const it of items) for (const [m, price, unit] of it.p) now.set(cartKey(m, it), [price, unit]);
  for (const c of cart) {
    const p = now.get(c.key);
    if (p) [c.price, c.unit] = p;
  }
  saveCart();
}

// ─── Arama ─────────────────────────────────────────────────────────────
let lastHits = [], shown = 0;

// "süt" aranınca çilekli süt değil düz süt öne çıksın: bu kelimeler aranmadıysa ürün biraz geriye düşer.
const FLAVORS = new Set(["aromali", "cilekli", "kakaolu", "muzlu", "cikolatali", "vanilyali", "karamelli", "ballı", "meyveli", "cocuk", "bebek"].map(norm));

function score(it, tokens) {
  let total = 0;
  for (const w of it.w) if (FLAVORS.has(w) && !tokens.includes(w)) total -= 3;
  for (const t of tokens) {
    let best = 0;
    it.w.forEach((w, k) => {
      if (w === t) best = Math.max(best, k === 0 ? 6 : 4);
      else if (w.startsWith(t)) best = Math.max(best, k === 0 ? 3 : 2);
    });
    if (it.cw.includes(t)) best += 5;
    if (!best) return 0;
    total += best;
  }
  return Math.max(total, 1);
}

const toTokens = (q) => norm(q).split(" ").filter(Boolean);

/** Aranan şey aktüelde var mı: BİM / A101 / Yunus aktüel ürünleri ve broşürlerde geçtiği sayfalar. */
function aktuelMatches(tokens) {
  const akt = items
    .filter((it) => it.d)
    .map((it) => [score(it, tokens), it])
    .filter(([s]) => s > 0)
    .sort((a, b) => a[1].ds.localeCompare(b[1].ds) || b[0] - a[0])
    .map(([, it]) => it);
  const pages = [];
  for (const b of brochures) {
    const hit = b.images.map((_, i) => i)
      .filter((i) => b.pw[i] && tokens.every((t) => b.pw[i].some((w) => w.startsWith(t))));
    if (hit.length) pages.push({ b, pages: hit });
  }
  return { akt, pages };
}

const uniq = (arr) => [...new Set(arr)];

function search() {
  const q = $("#q").value.trim();
  $("#suggest").hidden = !!q;
  if (!q) { $("#results").innerHTML = ""; return; }
  const tokens = toTokens(q);
  // Aktüel ürünler normal listede değil, en üstteki "Aktüelde de var" kutusunda gösterilir.
  lastHits = items
    .filter((it) => !it.d)
    .map((it) => [score(it, tokens), it])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1].u - b[1].u || a[1].p[0][1] - b[1].p[0][1])
    .map(([, it]) => it);
  const { akt, pages } = aktuelMatches(tokens);
  shown = 0;
  $("#results").innerHTML = "";
  if (akt.length || pages.length) {
    const lines = [];
    for (const m of AKTUEL_MARKETS) {
      const list = akt.filter((it) => it.p[0][0] === m);
      if (list.length) lines.push(`<li><b>${MARKETS[m].name} aktüel:</b> ${uniq(list.map((it) => it.d)).map(esc).join(", ")} <small>(${list.length} ürün)</small></li>`);
    }
    for (const p of pages) lines.push(`<li><b>${esc(p.b.title || p.b.name)}:</b> ${p.pages.map((i) => i + 1).join(", ")}. sayfada geçiyor</li>`);
    $("#results").innerHTML = `<div class="aktuel-alert"><p class="aa-title">📰 Aktüelde de var!</p><ul>${lines.join("")}</ul>
      <button class="see-aktuel">Aktüelde göster</button></div>`;
  }
  if (!lastHits.length) {
    if (!akt.length && !pages.length) {
      $("#results").innerHTML = items.length
        ? `<div class="empty"><big>🤔</big>"${esc(q)}" bulunamadı.<br>Başka bir kelimeyle dene.</div>`
        : `<div class="empty"><big>⏳</big>Fiyatlar yükleniyor…</div>`;
    }
    return;
  }
  showMore();
}

function showMore() {
  $("#results .more")?.remove();
  const next = lastHits.slice(shown, shown + PAGE);
  shown += next.length;
  $("#results").insertAdjacentHTML("beforeend", next.map(cardHtml).join(""));
  if (shown < lastHits.length) {
    $("#results").insertAdjacentHTML("beforeend", `<button class="more">Daha fazla göster (${lastHits.length - shown})</button>`);
  }
}

function cardHtml(it) {
  const idx = items.indexOf(it);
  const offers = it.p.map(([m, price, unit, promo], i) => {
    const mk = MARKETS[m];
    const key = cartKey(m, it);
    return `<div class="offer ${i === 0 && it.p.length > 1 ? "best" : ""}">
      <span class="badge" style="background:${mk.color};color:${mk.text || "#fff"}">${mk.name}</span>
      <div><span class="price">${tl(price)}</span>${unit ? `<span class="unit">${esc(unit)}</span>` : ""}
        ${i === 0 && it.p.length > 1 ? `<span class="tag cheap">En ucuz</span> ` : ""}${promo ? `<span class="tag">${esc(promo)}</span>` : ""}</div>
      <div data-key="${esc(key)}" data-idx="${idx}" data-m="${m}">${addControl(key)}</div>
    </div>`;
  }).join("");
  return `<article class="card">
    <div class="card-head">
      ${it.i ? `<img src="${esc(it.i)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}
      <div class="card-title"><div class="name">${esc(it.n)}</div>${it.s ? `<div class="size">${esc(it.s)}</div>` : ""}
        ${it.d ? "" : bellHtml(it, idx)}</div>
    </div>${offers}</article>`;
}

function addControl(key) {
  const c = cart.find((x) => x.key === key);
  if (!c) return `<button class="add" data-act="add">Ekle</button>`;
  return `<div class="stepper"><button data-act="dec" aria-label="Azalt">−</button><output>${c.qty}</output><button data-act="inc" aria-label="Arttır">+</button></div>`;
}

// ─── Sepet ─────────────────────────────────────────────────────────────
let cart = [];
try { cart = JSON.parse(localStorage.getItem("sepet") || "[]"); } catch { cart = []; }

const cartKey = (m, it) => `${m}|${it.n}|${it.s}`;

function saveCart() {
  try { localStorage.setItem("sepet", JSON.stringify(cart)); } catch { /* yer yoksa sessiz geç */ }
  const n = cart.reduce((a, c) => a + c.qty, 0);
  $("#cartCount").hidden = !n;
  $("#cartCount").textContent = n;
}

function changeQty(key, delta, it, m) {
  let c = cart.find((x) => x.key === key);
  if (!c && delta > 0) {
    const [, price, unit] = it.p.find((o) => o[0] === m);
    c = { key, m, n: it.n, s: it.s, price, unit, qty: 0, done: false };
    cart.push(c);
    toast(`Sepete eklendi: ${it.n} (${MARKETS[m].name})`);
  }
  if (!c) return;
  c.qty += delta;
  if (c.qty <= 0) cart = cart.filter((x) => x !== c);
  saveCart();
}

function renderCart() {
  const el = $("#cart");
  if (!cart.length) {
    el.innerHTML = `<div class="empty"><big>🧺</big>Sepetin boş.<br>"Ara" kısmından ürün ekleyebilirsin.</div>`;
    return;
  }
  const groups = {};
  cart.forEach((c) => (groups[c.m] ||= []).push(c));
  let grand = 0;
  const html = Object.keys(MARKETS).filter((m) => groups[m]).map((m) => {
    const mk = MARKETS[m];
    const sub = groups[m].reduce((a, c) => a + c.price * c.qty, 0);
    grand += sub;
    return `<section class="market-group">
      <h2 style="background:${mk.color};color:${mk.text || "#fff"}"><span>${mk.name}</span><span>${tl(sub)}</span></h2>
      ${groups[m].map((c) => `<div class="cart-item ${c.done ? "done" : ""}" data-key="${esc(c.key)}">
        <button class="check" data-act="toggle" aria-label="Aldım">${c.done ? "✓" : ""}</button>
        <div><div class="ci-name">${esc(c.n)}</div><div class="ci-sub">${c.qty} adet × ${tl(c.price)}</div></div>
        <div class="stepper"><button data-act="dec" aria-label="Azalt">−</button><output>${c.qty}</output><button data-act="inc" aria-label="Arttır">+</button></div>
      </div>`).join("")}
    </section>`;
  }).join("");
  el.innerHTML = `<p class="section-title">Aldıklarının yanındaki kutuya dokun ✓</p>${html}
    <div class="total"><div><small>Tahmini toplam</small><strong>${tl(grand)}</strong></div><span class="piggy" aria-hidden="true">🐷</span></div>
    <a class="big-btn wa" href="https://wa.me/?text=${encodeURIComponent(whatsappText(groups, grand))}" target="_blank" rel="noopener">💬 WhatsApp'la gönder</a>
    <button class="big-btn clear" data-act="clear">🗑️ Sepeti boşalt</button>`;
}

function whatsappText(groups, grand) {
  const lines = ["🛒 *HesaplıSepet – Alışveriş listem*", ""];
  Object.keys(MARKETS).filter((m) => groups[m]).forEach((m) => {
    lines.push(`*${MARKETS[m].name}*`);
    groups[m].forEach((c) => lines.push(`${c.done ? "✅" : "▫️"} ${c.n}${c.qty > 1 ? " × " + c.qty : ""} — ${tl(c.price * c.qty)}`));
    lines.push("");
  });
  lines.push(`*Toplam: ${tl(grand)}*`);
  return lines.join("\n");
}

// ─── Aktüel ve broşürler ───────────────────────────────────────────────
const BROCHURE_COLORS = {
  "Şok": ["#e0a800", "#1c1c1c"],
  "Çağdaş": ["#e65100", "#fff"],
  "Anadolu Tat": ["#2e7d32", "#fff"],
  "Yunus": ["#6a1b9a", "#fff"],
};
let aktuelShown = null; // ekranda hangi aramanın sonucu var (aynıysa yeniden çizme)

// Uzun bir bölüm, sabit duran başlığından kapatılınca sayfa o bölümün başına döner.
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.matches?.(".fold") || d.open) return;
  const topBar = $(".top").offsetHeight;
  if (d.getBoundingClientRect().top < topBar) scrollTo(0, d.getBoundingClientRect().top + scrollY - topBar - 8);
}, true);
// Her bölüm açılır-kapanır; başlık kaydırırken üstte sabit durur, dokununca kapanır.
const fold = (title, count, color, body, open = false) =>
  `<details class="fold" ${open ? "open" : ""}><summary style="background:${color[0]};color:${color[1]}"><span>${esc(title)} <small>(${count})</small></span></summary>
    <div class="fold-body">${body}</div></details>`;

const pageImg = (b, i) =>
  `<a href="${esc(b.images[i])}" target="_blank" rel="noopener"><img class="page" src="${esc(b.images[i])}" alt="${esc(b.name)} broşürü sayfa ${i + 1}" loading="lazy"></a>`;

function brochureFold(b, pageIdx, open, note = "") {
  const count = (b.date ? b.date + " · " : "") + (note || `${b.images.length} sayfa`);
  return fold(b.title || `${b.name} fırsatları`, count, BROCHURE_COLORS[b.name] || ["#555", "#fff"],
    pageIdx.map((i) => pageImg(b, i)).join("") +
    (b.pdf ? `<a class="pdf" href="${esc(b.pdf)}" target="_blank" rel="noopener">📄 Broşürün aslını aç (PDF)</a>` : "") +
    `<p class="src">Kaynak: ${esc(new URL(b.url).hostname)}</p>`, open);
}

/** Aktüel ürünleri market market (BİM, A101, Yunus), içinde de tarih/kampanya bölümleriyle gösterir. */
function aktuelSections(list, open, hint = "") {
  return AKTUEL_MARKETS.map((m) => {
    const byDate = {};
    list.filter((it) => it.p[0][0] === m).forEach((it) => (byDate[it.ds + "|" + it.d] ||= []).push(it));
    const keys = Object.keys(byDate).sort();
    if (!keys.length) return "";
    const color = [MARKETS[m].color, MARKETS[m].text || "#fff"];
    return `<h2 class="aktuel-title">${MARKETS[m].name} Aktüel</h2>${hint}` + keys.map((k) =>
      fold(k.split("|")[1], `${byDate[k].length} ürün`, color, byDate[k].map(cardHtml).join(""), open)).join("");
  }).join("");
}

function renderAktuel(force = false) {
  const q = $("#aq").value.trim();
  if (!force && aktuelShown === q) return;
  const el = $("#aktuel");
  if (!items.length) { el.innerHTML = `<div class="empty"><big>⏳</big>Yükleniyor…</div>`; return; }
  aktuelShown = q;
  const all = (pages) => pages.map((_, i) => i);

  if (!q) {
    el.innerHTML = aktuelSections(items.filter((it) => it.d), false, `<p class="section-title">Tarihe dokun, ürünler açılsın.</p>`) +
      `<h2 class="aktuel-title">Broşürler</h2><p class="section-title">Broşürü açmak için adına, büyütmek için resme dokun.</p>` +
      brochures.map((b) => brochureFold(b, all(b.images), false)).join("");
    return;
  }

  // Arama: sadece eşleşen aktüel ürünleri ve broşürlerde ürünün geçtiği sayfalar, açık gelir.
  const { akt, pages } = aktuelMatches(toTokens(q));
  const unsearchable = brochures.filter((b) => !b.texts);
  let html = "";
  html += aktuelSections(akt, true);
  if (pages.length) {
    html += `<h2 class="aktuel-title">Broşürlerde geçiyor</h2>` + pages.map(({ b, pages: idx }) =>
      brochureFold(b, idx, true, `${idx.map((i) => i + 1).join(", ")}. sayfa`)).join("");
  }
  if (!html) html = `<div class="empty"><big>🤔</big>Aktüelde "${esc(q)}" bulunamadı.</div>`;
  if (unsearchable.length) {
    html += `<h2 class="aktuel-title">Bunlara göz at</h2><p class="section-title">${unsearchable.map((b) => esc(b.name)).join(" ve ")} broşürleri resim olduğu için içinde arama yapılamıyor.</p>` +
      unsearchable.map((b) => brochureFold(b, all(b.images), false)).join("");
  }
  el.innerHTML = html;
}

// ─── Fiyat takibi ──────────────────────────────────────────────────────
let bgCheckOk = false; // uygulama kapalıyken günlük kontrol (Chrome'un periodic sync özelliği) açık mı
let watchCtx = null;   // hedef fiyat penceresi hangi ürün için açık

const whereText = (best) => best.d ? `${MARKETS[best.m].name} aktüel · ${best.d}` : MARKETS[best.m].name;
const bestNow = (n) => sources ? checkAlerts([{ key: nameKey(n), target: 0 }], sources)[0].best : null;

function bellHtml(it, idx) {
  const a = alerts.find((x) => x.key === nameKey(it.n));
  return `<button class="bell ${a ? "on" : ""}" data-watch="${idx}" data-key="${esc(nameKey(it.n))}">${a ? "🔔 " + tl(a.target) : "🔔 Takip et"}</button>`;
}

function refreshBells() {
  document.querySelectorAll(".bell[data-key]").forEach((b) => {
    const a = alerts.find((x) => x.key === b.dataset.key);
    b.classList.toggle("on", !!a);
    b.textContent = a ? "🔔 " + tl(a.target) : "🔔 Takip et";
  });
}

function openWatch(it) {
  const key = nameKey(it.n);
  const existing = alerts.find((a) => a.key === key);
  const best = bestNow(it.n);
  watchCtx = { key, n: it.n, s: it.s || "" };
  $("#wdName").textContent = it.n;
  $("#wdNow").innerHTML = best ? `Şu an en ucuz: <b>${tl(best.price)}</b> (${esc(whereText(best))})` : "";
  const target = existing ? existing.target : Math.floor((best ? best.price : 0) * 0.9);
  $("#wdPrice").value = String(target).replace(".", ",");
  $("#watchDlg").showModal();
}

const parsePrice = (v) => parseFloat(String(v).trim().replace(",", "."));

$("#watchDlg").addEventListener("click", (e) => {
  const step = e.target.closest("[data-step]");
  if (!step) return;
  const t = parsePrice($("#wdPrice").value) || 0;
  const amount = t < 50 ? 1 : t < 200 ? 5 : 10;
  $("#wdPrice").value = String(Math.max(0, Math.round(t + amount * +step.dataset.step))).replace(".", ",");
});

$("#watchDlg").addEventListener("close", async () => {
  if ($("#watchDlg").returnValue !== "save" || !watchCtx) return;
  const target = parsePrice($("#wdPrice").value);
  if (!(target > 0)) return toast("Geçerli bir fiyat yaz.");
  let a = alerts.find((x) => x.key === watchCtx.key);
  if (!a) {
    a = { id: Date.now().toString(36), key: watchCtx.key, n: watchCtx.n, s: watchCtx.s };
    alerts.push(a);
  }
  a.target = Math.round(target * 100) / 100;
  delete a.notified;
  const best = bestNow(a.n);
  if (best && best.price <= a.target) {
    a.notified = { price: best.price, m: best.m, d: best.d }; // zaten ucuz: hemen bildirim atma, ekranda söyle
    toast(`Şu an zaten bu fiyatın altında: ${tl(best.price)} (${whereText(best)})`);
  } else {
    toast(`Takibe alındı. ${tl(a.target)} ya da altına inince haber vereceğiz.`);
  }
  await saveAlerts(alerts);
  refreshBells();
  if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  await setupBackgroundCheck();
  await updateTakip(false);
});

/** Uygulama kapalıyken Chrome'un günde yaklaşık bir kez kontrol etmesini ister (sadece yüklü uygulamada çalışır). */
async function setupBackgroundCheck() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!("periodicSync" in reg)) return (bgCheckOk = false);
    const st = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (st.state !== "granted") return (bgCheckOk = false);
    await reg.periodicSync.register("fiyat-kontrol", { minInterval: 12 * 60 * 60 * 1000 });
    return (bgCheckOk = true);
  } catch { return (bgCheckOk = false); }
}

/** Takip sonuçlarını hesaplar; istenirse yeni indirimler için bildirim gösterir, rozeti günceller. */
async function updateTakip(notify) {
  if (!sources) return;
  if (notify && alerts.length && "Notification" in window && Notification.permission === "granted") {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (await notifyNewHits(reg, alerts, sources)) await saveAlerts(alerts);
    } catch { /* bildirim gösterilemezse Takip sekmesinde yine görünür */ }
  }
  const hits = checkAlerts(alerts, sources).filter((r) => r.hit).length;
  $("#takipCount").hidden = !hits;
  $("#takipCount").textContent = hits;
  if ($("#tab-takip").classList.contains("active")) renderTakip();
}

function permissionNote() {
  if (!alerts.length) return "";
  if (!("Notification" in window)) return `<p class="note">Bu tarayıcı bildirim göstermiyor. İndirimleri bu sayfadan takip edebilirsin.</p>`;
  if (Notification.permission === "denied") return `<p class="note warn">Bildirimler kapalı. Telefonun Ayarlar → Uygulamalar → Chrome (ya da HesaplıSepet) → Bildirimler kısmından açabilirsin.</p>`;
  if (Notification.permission === "default") return `<button class="big-btn perm" data-perm>🔔 Bildirimlere izin ver</button>`;
  if (!bgCheckOk) return `<p class="note">Uygulama kapalıyken de haber alman için uygulamayı ana ekrana ekle. Uygulamayı her açtığında da kontrol edilir.</p>`;
  return `<p class="note ok">✓ Bildirimler açık. Her gün kontrol ediliyor.</p>`;
}

function renderTakip() {
  const el = $("#takip");
  let html = `<h2 class="aktuel-title">Fiyat takibi</h2>
    <p class="section-title">Takip ettiğin ürün istediğin fiyata ya da altına inince haber verilir. Bütün marketlere ve BİM / A101 / Yunus aktüele bakılır.</p>${permissionNote()}`;
  if (!alerts.length) {
    el.innerHTML = html + `<div class="empty"><big>🔔</big>Henüz takip ettiğin ürün yok.<br>"Ara" kısmında ürünün yanındaki <b>🔔 Takip et</b> butonuna dokun.</div>`;
    return;
  }
  const res = sources ? checkAlerts(alerts, sources) : alerts.map((a) => ({ alert: a, best: null, hit: false }));
  res.sort((x, y) => y.hit - x.hit);
  el.innerHTML = html + res.map(({ alert: a, best, hit }) => `
    <article class="watch-card ${hit ? "hit" : ""}" data-id="${esc(a.id)}">
      <div class="name">${esc(a.n)}</div>
      <div>Hedefin: <b>${tl(a.target)}</b></div>
      ${!best ? `<div class="watch-status">Şu an hiçbir markette bulunamadı.</div>`
        : hit ? `<div class="watch-status hit">✅ İndirimde! ${tl(best.price)} · ${esc(whereText(best))}</div>`
        : `<div class="watch-status">Şu an en ucuz: ${tl(best.price)} · ${esc(whereText(best))}</div>`}
      ${best && best.d ? `<div class="ci-sub">${esc(best.n)}</div>` : ""}
      <div class="watch-actions">
        <button data-wfind>🔍 Bul</button><button data-wedit>Hedefi değiştir</button><button data-wdel class="del">Sil</button>
      </div>
    </article>`).join("");
}

$("#takip").addEventListener("click", async (e) => {
  if (e.target.closest("[data-perm]")) {
    await Notification.requestPermission();
    await setupBackgroundCheck();
    return updateTakip(true);
  }
  const card = e.target.closest("[data-id]");
  if (!card) return;
  const a = alerts.find((x) => x.id === card.dataset.id);
  if (!a) return;
  if (e.target.closest("[data-wfind]")) {
    $("#q").value = a.n;
    showTab("search");
    return search();
  }
  if (e.target.closest("[data-wedit]")) return openWatch({ n: a.n, s: a.s });
  if (e.target.closest("[data-wdel]") && confirm(`"${a.n}" takipten çıkarılsın mı?`)) {
    alerts = alerts.filter((x) => x !== a);
    await saveAlerts(alerts);
    refreshBells();
    updateTakip(false);
    renderTakip();
  }
});

// Bildirime dokununca uygulama açıksa Takip sekmesine geç.
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.tab) showTab(e.data.tab); });

// ─── Arayüz olayları ───────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  document.querySelectorAll(".bottom button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "cart") renderCart();
  if (name === "aktuel") renderAktuel();
  if (name === "takip") renderTakip();
  scrollTo(0, 0);
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

document.querySelectorAll(".bottom button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

let debounce;
$("#q").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(search, 250); });
$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); search(); $("#q").blur(); });

$("#suggest").innerHTML = `<p class="tagline"><b>Karşılaştır, listele, tasarruf et.</b></p><h2>Sık arananlar</h2>
  <div class="chips">${SUGGESTIONS.map(([icon, s]) => `<button class="chip" data-q="${s}"><span aria-hidden="true">${icon}</span>${s}</button>`).join("")}</div>`;
$("#suggest").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $("#q").value = chip.dataset.q;
  search();
});

function onCardClick(e) {
  if (e.target.matches(".more")) return showMore();
  const bell = e.target.closest("[data-watch]");
  if (bell) return openWatch(items[+bell.dataset.watch]);
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const box = btn.closest("[data-key]");
  const it = items[+box.dataset.idx];
  changeQty(box.dataset.key, btn.dataset.act === "dec" ? -1 : 1, it, box.dataset.m);
  box.innerHTML = addControl(box.dataset.key);
}
$("#results").addEventListener("click", (e) => {
  if (e.target.matches(".see-aktuel")) {
    $("#aq").value = $("#q").value;
    return showTab("aktuel");
  }
  onCardClick(e);
});
$("#aktuel").addEventListener("click", onCardClick);

let aDebounce;
$("#aq").addEventListener("input", () => { clearTimeout(aDebounce); aDebounce = setTimeout(renderAktuel, 300); });
$("#aktuelForm").addEventListener("submit", (e) => { e.preventDefault(); renderAktuel(); $("#aq").blur(); });

$("#cart").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "clear") {
    if (confirm("Sepetteki her şey silinsin mi?")) { cart = []; saveCart(); renderCart(); }
    return;
  }
  const c = cart.find((x) => x.key === btn.closest("[data-key]").dataset.key);
  if (!c) return;
  if (act === "toggle") c.done = !c.done;
  if (act === "inc") c.qty++;
  if (act === "dec") {
    c.qty--;
    if (c.qty <= 0) cart = cart.filter((x) => x !== c);
  }
  saveCart();
  renderCart();
});

// Sesle arama (Android Chrome destekliyor)
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Speech) {
  const mic = $("#micBtn");
  mic.hidden = false;
  mic.addEventListener("click", () => {
    const rec = new Speech();
    rec.lang = "tr-TR";
    rec.onresult = (e) => { $("#q").value = e.results[0][0].transcript; search(); };
    rec.onend = () => mic.classList.remove("listening");
    rec.onerror = () => toast("Ses anlaşılamadı, tekrar dene.");
    mic.classList.add("listening");
    toast("Dinliyorum… ürünün adını söyle");
    rec.start();
  });
}

// Ana ekrana ekleme
let installEvt;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
$("#installBtn").addEventListener("click", async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $("#installBtn").hidden = true;
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

// Android uygulamayı arka planda bekletip kaldığı yerden açıyor; uzun aradan sonra
// öne gelince sayfayı yenile ki yeni sürüm ve günün fiyatları gelsin.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1000) location.reload();
});

saveCart();
loadData();
