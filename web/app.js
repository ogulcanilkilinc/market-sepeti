"use strict";

const MARKETS = {
  a101:        { name: "A101",        color: "#0099d8" },
  bim:         { name: "BİM",         color: "#d7141a" },
  sok:         { name: "Şok",         color: "#e0a800", text: "#1c1c1c" },
  migros:      { name: "Migros",      color: "#f07d00" },
  carrefour:   { name: "CarrefourSA", color: "#1e4fa0" },
  tarim_kredi: { name: "Tarım Kredi", color: "#2e7d32" },
  yunus:       { name: "Yunus",       color: "#6a1b9a" },
};
const SUGGESTIONS = ["Süt", "Ekmek", "Yumurta", "Beyaz peynir", "Yoğurt", "Domates", "Patates", "Soğan",
  "Ayçiçek yağı", "Zeytinyağı", "Çay", "Şeker", "Un", "Pirinç", "Makarna", "Tavuk", "Kıyma", "Deterjan"];
const PAGE = 30;

const $ = (s) => document.querySelector(s);
const tl = (n) => n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₺";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** "Süt", "SUT", "süt" -> "sut". Türkçe harfleri sadeleştirir. */
function norm(s) {
  return String(s).toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i").replace(/[^a-z0-9]+/g, " ").trim();
}
const unitValue = (u) => { const m = u && u.match(/([\d.]+,\d+)/); return m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : Infinity; };

// ─── Veri ──────────────────────────────────────────────────────────────
let items = [];

async function loadData() {
  try {
    const res = await fetch("data/products.json", { cache: "no-cache" });
    const data = await res.json();
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
  } catch (e) {
    $("#updated").textContent = "Fiyatlar yüklenemedi. İnternet bağlantını kontrol et.";
  }
  if ($("#q").value) search();
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

function search() {
  const q = $("#q").value.trim();
  $("#suggest").hidden = !!q;
  if (!q) { $("#results").innerHTML = ""; return; }
  const tokens = norm(q).split(" ").filter(Boolean);
  lastHits = items
    .map((it) => [score(it, tokens), it])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1].u - b[1].u || a[1].p[0][1] - b[1].p[0][1])
    .map(([, it]) => it);
  shown = 0;
  $("#results").innerHTML = "";
  if (!lastHits.length) {
    $("#results").innerHTML = items.length
      ? `<div class="empty"><big>🤔</big>"${esc(q)}" bulunamadı.<br>Başka bir kelimeyle dene.</div>`
      : `<div class="empty"><big>⏳</big>Fiyatlar yükleniyor…</div>`;
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
      <div><div class="name">${esc(it.n)}</div>${it.s ? `<div class="size">${esc(it.s)}</div>` : ""}</div>
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
    <div class="total"><span>Toplam</span><span>${tl(grand)}</span></div>
    <a class="big-btn wa" href="https://wa.me/?text=${encodeURIComponent(whatsappText(groups, grand))}" target="_blank" rel="noopener">💬 WhatsApp'la gönder</a>
    <button class="big-btn clear" data-act="clear">🗑️ Sepeti boşalt</button>`;
}

function whatsappText(groups, grand) {
  const lines = ["🛒 *Alışveriş listem*", ""];
  Object.keys(MARKETS).filter((m) => groups[m]).forEach((m) => {
    lines.push(`*${MARKETS[m].name}*`);
    groups[m].forEach((c) => lines.push(`${c.done ? "✅" : "▫️"} ${c.n}${c.qty > 1 ? " × " + c.qty : ""} — ${tl(c.price * c.qty)}`));
    lines.push("");
  });
  lines.push(`*Toplam: ${tl(grand)}*`);
  return lines.join("\n");
}

// ─── Aktüel ve broşürler ───────────────────────────────────────────────
let aktuelLoaded = false;
async function renderAktuel() {
  if (aktuelLoaded) return;
  const el = $("#aktuel");
  el.innerHTML = `<div class="empty"><big>⏳</big>Yükleniyor…</div>`;
  try {
    const data = await (await fetch("data/brochures.json", { cache: "no-cache" })).json();
    // BİM aktüel: tarih tarih, bugüne en yakın olan açık gelir.
    const byDate = {};
    items.filter((it) => it.d).forEach((it) => (byDate[it.ds + "|" + it.d] ||= []).push(it));
    const today = new Date().toLocaleDateString("sv"); // yerel tarih, YYYY-AA-GG
    const keys = Object.keys(byDate).sort();
    const openKey = keys.filter((k) => k.slice(0, 10) <= today).pop() || keys[0];
    const bim = keys.length ? `<h2 class="aktuel-title">BİM Aktüel</h2>` + keys.map((k) =>
      `<details class="aktuel-day" ${k === openKey ? "open" : ""}><summary>${esc(k.split("|")[1])} <small>(${byDate[k].length} ürün)</small></summary>
        ${byDate[k].map(cardHtml).join("")}</details>`).join("") : "";
    el.innerHTML = bim +
      `<p class="section-title">Aşağıdaki marketler fiyat listesi yayınlamıyor, haftalık fırsatlarını buradan görebilirsin. Büyütmek için resme dokun.</p>` +
      data.brochures.map((b) => `<section class="brochure"><h2>${esc(b.name)} fırsatları</h2>
        ${b.images.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(b.name)} broşürü" loading="lazy"></a>`).join("")}
        <p class="src">Kaynak: ${esc(new URL(b.url).hostname)}</p></section>`).join("");
    aktuelLoaded = items.length > 0;
  } catch {
    el.innerHTML = `<div class="empty"><big>📶</big>Yüklenemedi. İnternet bağlantını kontrol et.</div>`;
  }
}

// ─── Arayüz olayları ───────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  document.querySelectorAll(".bottom button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "cart") renderCart();
  if (name === "aktuel") renderAktuel();
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

$("#suggest").innerHTML = `<h2>Sık arananlar</h2><div class="chips">${SUGGESTIONS.map((s) => `<button class="chip">${s}</button>`).join("")}</div>`;
$("#suggest").addEventListener("click", (e) => {
  if (!e.target.matches(".chip")) return;
  $("#q").value = e.target.textContent;
  search();
});

function onCardClick(e) {
  if (e.target.matches(".more")) return showMore();
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const box = btn.closest("[data-key]");
  const it = items[+box.dataset.idx];
  changeQty(box.dataset.key, btn.dataset.act === "dec" ? -1 : 1, it, box.dataset.m);
  box.innerHTML = addControl(box.dataset.key);
}
$("#results").addEventListener("click", onCardClick);
$("#aktuel").addEventListener("click", onCardClick);

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

saveCart();
loadData();
