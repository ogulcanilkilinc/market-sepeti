"""Market Sepeti veri toplayıcı.

Her gün GitHub Actions'ta çalışır ve web/data/ altına iki dosya yazar:
  products.json  - aranabilir ürünler ve market fiyatları
  brochures.json - Çağdaş ve Anadolu Tat haftalık broşür görselleri

Kaynaklar:
  marketfiyati.org.tr (TÜBİTAK) -> A101, BİM, Şok, Migros, CarrefourSA, Tarım Kredi
  yunusonline.com               -> Yunus Market
  cagdasmarketler.com           -> Çağdaş broşürü (görsel + OCR metni)
  anadolutat.com/kampanyalar    -> Anadolu Tat fırsatları (görsel + OCR metni)

Bir kaynak çökerse, o kaynağın bir önceki günkü verisi (--previous) korunur.
Sadece standart kütüphane kullanılır.
"""

import argparse
import base64
import functools
import html
import http.client as http_client
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Annemin konumu: Çankaya / Nasuh Akar Mahallesi merkezi (OpenStreetMap). Yarıçap km.
LAT, LON, DISTANCE_KM = 39.9104, 32.8217, 5

MF_API = "https://api.marketfiyati.org.tr"
MF_MARKETS = {"a101", "bim", "sok", "migros", "carrefour", "tarim_kredi"}
MF_PAGE_SIZE = 25  # sunucu 25'in üstünü sessizce 25'e indiriyor
YUNUS = "https://yunusonline.com"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
MF_DELAY = 1.5  # sn; marketfiyati hızlı isteklerde bağlantıyı kesiyor, nazik olalım
# Annemin ihtiyacı olmayan kategoriler (istek sayısını azaltır).
MF_SKIP = {"Elektronik ve Teknoloji", "Giyim ve Tekstil", "Oyuncak Hobi Ve Kırtasiye", "Oto ve Yapı Market",
           "Makyaj", "Parfüm ve Deodorant"}
TR_TZ = timezone(timedelta(hours=3))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http(url, data=None, headers=None, tries=4):
    """GET (data=None) veya JSON POST. Ağ hatası / bağlantı kopması / 5xx için tekrar dener."""
    # Tarayıcı benzeri başlıklar: eksik olunca marketfiyati'nin bot koruması bağlantıyı kesiyor.
    hdrs = {"User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9", "Connection": "keep-alive", **(headers or {})}
    body = None
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        hdrs["Content-Type"] = "application/json; charset=utf-8"
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers=hdrs)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == tries - 1:
                raise
        except (OSError, http_client.HTTPException):  # URLError, zaman aşımı, bağlantı kopması
            if attempt == tries - 1:
                raise
        time.sleep(30 * (attempt + 1))


# ─── marketfiyati.org.tr ────────────────────────────────────────────────

MF_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://marketfiyati.org.tr",
    "Referer": "https://marketfiyati.org.tr/",
}


def mf_post(path, payload):
    text = http(MF_API + path, payload, MF_HEADERS)
    if text.lstrip().startswith("<"):
        raise RuntimeError(f"marketfiyati {path}: JSON yerine HTML geldi (WAF engeli)")
    return json.loads(text)


def scrape_marketfiyati():
    depots = mf_post("/api/v2/nearest", {"latitude": LAT, "longitude": LON, "distance": DISTANCE_KM})
    depot_ids = [d["id"] for d in depots if d.get("marketName") in MF_MARKETS]
    log(f"marketfiyati: {len(depot_ids)} yakın şube")
    if not depot_ids:
        raise RuntimeError("marketfiyati: yakında şube bulunamadı")

    cats = json.loads(http(MF_API + "/api/v1/info/categories", headers=MF_HEADERS))["content"]
    subs = [sub for cat in cats for sub in cat["subcategories"] if sub not in MF_SKIP]
    products, failed, streak = {}, [], 0
    for sub in subs:
        page, seen = 0, 0
        try:
            while True:
                res = mf_post("/api/v2/searchByCategories", {
                    "menuCategory": False, "keywords": sub, "pages": page, "size": MF_PAGE_SIZE,
                    "latitude": LAT, "longitude": LON, "distance": DISTANCE_KM, "depots": depot_ids,
                })
                content = res.get("content") or []
                for p in content:
                    item = mf_item(p, sub)
                    if item:
                        products[p["id"]] = item
                seen += len(content)
                total = res.get("numberOfFound") or 0
                time.sleep(MF_DELAY)
                if not content or seen >= total:
                    break
                page += 1
            log(f"  {sub}: {seen}")
            streak = 0
        except Exception as e:  # noqa: BLE001 - bir kategori düşerse diğerleri devam etsin
            failed.append(sub)
            log(f"  {sub}: HATA {e!r}")
            streak += 1
            if streak >= 3:  # art arda düşüyorsa engellenmişiz, boşuna uğraşma
                raise RuntimeError("marketfiyati: art arda 3 kategori alınamadı") from e
            time.sleep(60)
    if len(failed) > len(subs) // 4:
        raise RuntimeError(f"marketfiyati: {len(failed)}/{len(subs)} kategori alınamadı")
    return list(products.values())


def mf_item(p, sub):
    # Her market için yakındaki şubelerin en ucuzunu al.
    best = {}
    for d in p.get("productDepotInfoList") or []:
        m = d.get("marketAdi")
        if m not in MF_MARKETS or not d.get("price"):
            continue
        if m not in best or d["price"] < best[m][1]:
            promo = d.get("promotionText") or ("İndirimde" if d.get("discount") else None)
            best[m] = [m, round(d["price"], 2), d.get("unitPrice") or None, promo]
    if not best:
        return None
    return {
        "n": p["title"].strip(),
        "s": p.get("refinedVolumeOrWeight") or "",
        "i": p.get("imageUrl") or "",
        "c": sub,
        "p": sorted(best.values(), key=lambda x: x[1]),
    }


# ─── Yunus Online ───────────────────────────────────────────────────────

YUNUS_CARD = re.compile(
    r'product-cart-wrap.*?<a href="(/[^"]+-p-\d+)">\s*<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)".*?'
    r'<span style="color:black">([0-9.,]+) ₺</span>',
    re.S,
)


def scrape_yunus():
    home = http(YUNUS + "/")
    cat_paths = sorted(set(re.findall(r'href="(/[a-z0-9-]+-t-\d+)"', home)))
    log(f"yunus: {len(cat_paths)} kategori")
    if not cat_paths:
        raise RuntimeError("yunus: kategori bulunamadı")
    products, failed = {}, 0
    for path in cat_paths:
        try:
            yunus_category(path, products)
        except Exception as e:  # noqa: BLE001
            failed += 1
            log(f"  {path}: HATA {e!r}")
    if failed > len(cat_paths) // 4:
        raise RuntimeError(f"yunus: {failed}/{len(cat_paths)} kategori alınamadı")
    log(f"yunus: {len(products)} ürün")
    return list(products.values())


def yunus_page(url):
    """Yunus sunucusu yoğunken ara sıra geçici 404 veriyor; bekleyip yeniden dener."""
    for attempt in range(3):
        try:
            return http(url)
        except urllib.error.HTTPError as e:
            if e.code != 404 or attempt == 2:
                raise
            time.sleep(5)


def yunus_category(path, products):
    page, prev_hrefs = 1, None
    while page <= 50:
        url = f"{YUNUS}{path}?p=x[{page}]-o[1]"
        cards = YUNUS_CARD.findall(yunus_page(url))
        hrefs = [c[0] for c in cards]
        if not cards or hrefs == prev_hrefs:  # son sayfa geçildi
            break
        prev_hrefs = hrefs
        for href, img, name, price in cards:
            if href in products:
                continue
            name = tr_title(html.unescape(name))
            price = float(price.replace(",", ""))
            products[href] = {
                "n": name,
                "s": "",
                "i": img,
                "c": "",
                "p": [["yunus", price, unit_price(name, price), None]],
            }
        time.sleep(0.2)
        page += 1


def tr_title(s):
    """'PINAR SÜT 1 LT' -> 'Pınar Süt 1 Lt'.

    Ad Türkçe harf içeriyorsa (İ, Ş, Ğ...) 'I' gerçekten 'ı'dır; içermiyorsa
    ('PEYNIR' gibi) site harfleri ASCII'ye çevirmiştir ve 'I' aslında 'i'dir.
    """
    s = s.strip()
    turkish = any(ch in s for ch in "İŞĞÜÖÇ")

    def word(w):
        first, rest = w[0], w[1:]
        rest = rest.replace("İ", "i").replace("I", "ı" if turkish else "i").lower()
        return first + rest
    return " ".join(word(w) for w in s.split())


UNIT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kg|gr|g|lt|l|ml|cl)\b", re.I)
UNIT_RE_X = re.compile(r"(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|gr|g|lt|l|ml|cl)\b", re.I)


def unit_price(name, price):
    """Ürün adından miktarı çıkarıp '69,50 ₺/Lt' gibi birim fiyat üretir."""
    low = name.lower()
    count = 1
    m = UNIT_RE_X.search(low)
    if m:
        count, qty, unit = int(m.group(1)), m.group(2), m.group(3)
    else:
        m = UNIT_RE.search(low)
        if not m:
            return "{:.2f} ₺/Kg".format(price).replace(".", ",") if re.search(r"\bkg\b", low) else None
        qty, unit = m.group(1), m.group(2)
    qty = float(qty.replace(",", ".")) * count
    if qty <= 0:
        return None
    factor = {"kg": 1, "gr": 1000, "g": 1000, "lt": 1, "l": 1, "ml": 1000, "cl": 100}[unit]
    base = "Kg" if unit in ("kg", "gr", "g") else "Lt"
    return "{:.2f} ₺/{}".format(price / qty * factor, base).replace(".", ",")


# ─── BİM aktüel ─────────────────────────────────────────────────────────

BIM_AKTUEL = "https://www.bim.com.tr/Categories/100/aktuel-urunler.aspx"
TR_MONTHS = ["ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz",
             "ağustos", "eylül", "ekim", "kasım", "aralık"]


def aktuel_dates(label, today):
    """'16 Ekim Cuma' -> (16 Eki, 16 Eki); '10-16 Ekim' -> (10 Eki, 16 Eki)."""
    m = re.match(r"(\d+)(?:-(\d+))?\s+(\w+)", label.strip())
    if not m or m.group(3).lower() not in TR_MONTHS:
        return None, None
    month = TR_MONTHS.index(m.group(3).lower()) + 1
    year = today.year + (1 if month < today.month - 6 else 0)  # aralık -> ocak geçişi
    try:
        start = datetime(year, month, int(m.group(1))).date()
        end = datetime(year, month, int(m.group(2) or m.group(1))).date()
    except ValueError:
        return None, None
    return start, end


def scrape_bim_aktuel():
    today = datetime.now(TR_TZ).date()
    tabs = re.findall(r'aktuel-urunler\.aspx\?Bim_AktuelTarihKey=(\d+)">\s*<span class="text">([^<]+)</span>',
                      http(BIM_AKTUEL), re.I)
    items = []
    for key, label in dict(tabs).items():
        start, end = aktuel_dates(label, today)
        # Son 4 gün ve önümüzdeki 10 gün içindeki aktüeller (eskilerde stok genelde bitmiş olur)
        if not start or not (end >= today - timedelta(days=4) and start <= today + timedelta(days=10)):
            continue
        page = http(f"{BIM_AKTUEL}?Bim_AktuelTarihKey={key}")
        for block in page.split('<div class="product col')[1:]:
            img = re.search(r'<img src="([^"]+)"', block)
            brand = re.search(r'<h2 class="subTitle">([^<]*)</h2>', block)
            title = re.search(r'<h2 class="title">\s*([^<]+?)\s*</h2>', block)
            whole = re.search(r'class="text quantify">([\d.]+),?</div>', block)
            kurus = re.search(r'<span class="number">(\d+)</span>', block)
            # Miktar "• 5 L" gibi yazıyor; bazı ürünlerde boş ("•"), o zaman sitede de miktar yok.
            size = re.search(r'<div class="gramajadet">(.*?)</div>', block, re.S)
            if not (title and whole):
                continue
            price = float(whole.group(1).replace(".", "") + "." + (kurus.group(1) if kurus else "00"))
            brand_s = html.unescape(brand.group(1)).strip() if brand else ""
            title_s = html.unescape(title.group(1)).strip()
            if brand_s and title_s.upper().startswith(brand_s.upper()):  # "CREALITY CREALITY ..." tekrarı
                brand_s = ""
            name = tr_title(f"{brand_s} {title_s}")
            size_s = " ".join(html.unescape(size.group(1)).replace("•", " ").split()) if size else ""
            items.append({
                "n": name, "s": size_s, "i": img.group(1) if img else "", "c": "", "d": label.strip(), "ds": start.isoformat(),
                "p": [["bim", price, None, f"Aktüel · {label.strip()}"]],
            })
        time.sleep(0.5)
    log(f"bim aktüel: {len(items)} ürün")
    return items


# ─── A101 aktüel ────────────────────────────────────────────────────────
# www.a101.com.tr bot korumalı; ama sitenin kendi kullandığı API (rio.a101.com.tr) açık.
# Kampanya kodları "Aldın Aldın" ve "Haftanın Yıldızları" sayfalarından (?value=Z110&field=promotionCode).
A101_SEARCH = "https://rio.a101.com.tr/dbmk89vnr/CALL/Store/search/VS032"
A101_PROMOS = {"Z110": "Aldın Aldın", "Z100": "Haftanın Yıldızları"}  # Z120 (eski aktüel stokları) alınmaz
A101_HEADERS = {"Accept": "application/json", "Origin": "https://www.a101.com.tr", "Referer": "https://www.a101.com.tr/"}


def tr_range(start, end):
    """(15 Eki, 21 Eki) -> '15-21 Ekim'; (28 Eki, 3 Kas) -> '28 Ekim - 3 Kasım'."""
    month = lambda d: TR_MONTHS[d.month - 1].capitalize()  # noqa: E731
    if start == end:
        return f"{start.day} {month(start)}"
    if start.month == end.month:
        return f"{start.day}-{end.day} {month(end)}"
    return f"{start.day} {month(start)} - {end.day} {month(end)}"


def a101_search(code, start):
    data = {"channel": "SLOT", "filters": [{"field": "promotionCode", "value": code}], "from": start, "limit": 99}
    encoded = base64.b64encode(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).decode()
    query = urllib.parse.urlencode({"__culture": "tr-TR", "__platform": "web", "data": encoded, "__isbase64": "true"})
    return json.loads(http(f"{A101_SEARCH}?{query}", headers=A101_HEADERS))


def scrape_a101_aktuel():
    today = datetime.now(TR_TZ).date()
    to_date = lambda ms: datetime.fromtimestamp(ms / 1000, TR_TZ).date()  # noqa: E731
    items = []
    for code, title in A101_PROMOS.items():
        start, found = 0, []
        while True:
            res = a101_search(code, start)
            for r in res.get("results") or []:
                promo, price, attrs = r.get("promotion") or {}, r.get("price") or {}, r.get("attributes") or {}
                if promo.get("code") != code or not (promo.get("startDate") and promo.get("endDate")):
                    continue
                begin, end = to_date(promo["startDate"]), to_date(promo["endDate"])
                if end < today or begin > today + timedelta(days=10):
                    continue
                value = (price.get("discounted") or price.get("normal") or 0) / 100
                if not value or not attrs.get("name"):
                    continue
                found.append((begin, end, value, r))
            start += 99
            if start >= (res.get("total") or 0) or not res.get("results"):
                break
            time.sleep(0.5)
        # Aylarca süren birkaç ürün ayrı küçük gruplar oluşturmasın: o haftanın ana grubuna katılsın.
        weekly = [(b, e) for b, e, _, _ in found if (e - b).days <= 10]
        main = max(set(weekly), key=weekly.count) if weekly else None
        for begin, end, value, r in found:
            if main and (end - begin).days > 10:
                begin, end = main
            attrs, rate = r["attributes"], (r.get("price") or {}).get("discountRate")
            label = f"{title} · {tr_range(begin, end)}"
            img = next((i["url"] for i in r.get("images", []) if i.get("imageType") == "product"), "")
            cats = r.get("categories") or [{}]
            items.append({
                "n": attrs["name"].strip(), "s": "", "i": img, "c": cats[-1].get("name", ""),
                "d": label, "ds": begin.isoformat(),
                "p": [["a101", round(value, 2), unit_price(attrs["name"], value),
                       label + (f" · %{rate} indirim" if rate else "")]],
            })
    log(f"a101 aktüel: {len(items)} ürün")
    if not items:
        raise RuntimeError("a101: güncel aktüel ürün bulunamadı")
    return items


# ─── Yunus aktüel (Akakçe üzerinden) ────────────────────────────────────
# yunusonline.com yurt dışından (GitHub) gelen bağlantıları kesiyor; tam katalog bu yüzden
# evdeki bilgisayardan gelir (push_yunus.py). Yunus'un haftalık aktüel paylaşımlarını ise
# Akakçe topluyor ve broşürdeki her ürünün adını ve fiyatını sayfaya gömüyor.
AKAKCE = "https://www.akakce.com"
AKAKCE_CDN = "https://cdn.akakce.com"
AKAKCE_YUNUS = AKAKCE + "/brosurler/yunusmarket"


def astro_value(v):
    """Akakçe sayfasına gömülü veri [0, değer] / [1, [liste]] biçiminde; düz Python'a çevirir."""
    if isinstance(v, list) and len(v) == 2 and v[0] in (0, 1):
        tag, inner = v
        if tag == 1:
            return [astro_value(x) for x in inner]
        return {k: astro_value(x) for k, x in inner.items()} if isinstance(inner, dict) else inner
    return v


def akakce_pages(page_html):
    t = html.unescape(page_html)
    i = t.find('"pages":')
    if i < 0:
        return []
    raw, _ = json.JSONDecoder().raw_decode(t, i + len('"pages":'))
    return astro_value(raw) or []


@functools.lru_cache(maxsize=1)
def yunus_aktuel():
    """Güncel Yunus aktüel paylaşımları: broşür girişi (sayfa görselleri + aranabilir ürün adları)
    ve fiyatlı ürünler. Broşür ve ürün listesi aynı taramadan çıkar (bir kez çalışır)."""
    today = datetime.now(TR_TZ).date()
    paths = sorted(set(re.findall(r'href="(/brosurler/yunusmarket-[^"]+)"', http(AKAKCE_YUNUS))))
    posts = []
    for path in paths:
        page = http(AKAKCE + path)
        time.sleep(0.7)
        rng = re.search(r'<span id="br_s">([^<]+)</span>', page)
        if not rng:
            continue
        start = aktuel_dates(rng.group(1).split("-")[0].strip(), today)[0]
        end = range_end(rng.group(1), today) or start
        if not start or end < today:
            continue
        posts.append((start, end, path, akakce_pages(page)))
    posts.sort(key=lambda p: p[0], reverse=True)  # en yeni paylaşım önce

    images, texts, items, seen_pages, seen_items = [], [], [], set(), set()
    for start, end, path, pages in posts:
        label = tr_range(start, end)
        for pg in pages:
            clips = [c for c in pg.get("clips") or [] if c.get("n")]
            sig = frozenset(c["n"] for c in clips)
            if sig and sig in seen_pages:  # Instagram ve Facebook'ta aynı sayfa iki kez paylaşılabiliyor
                continue
            seen_pages.add(sig)
            images.append(AKAKCE_CDN + (pg.get("hriURL") or pg.get("lriURL")))
            texts.append(" ".join(c["n"] for c in clips))
            for c in clips:
                if not c.get("p"):
                    continue
                price = float(c["p"].replace(".", "").replace(",", "."))
                if (c["n"], price) in seen_items:
                    continue
                seen_items.add((c["n"], price))
                items.append({
                    "n": c["n"].strip(), "s": "", "i": AKAKCE_CDN + c["tu"] if c.get("tu") else "", "c": "",
                    "d": label, "ds": start.isoformat(),
                    "p": [["yunus", price, unit_price(c["n"], price), f"Aktüel · {label}"]],
                })
    if not images:
        raise RuntimeError("yunus aktüel: güncel paylaşım bulunamadı")
    log(f"yunus aktüel: {len(images)} sayfa, {len(items)} fiyatlı ürün")
    brochure = {
        "name": "Yunus", "title": "Yunus aktüel",
        "date": tr_range(min(p[0] for p in posts), max(p[1] for p in posts)),
        "url": AKAKCE_YUNUS, "images": images, "texts": texts,
    }
    return {"brochure": brochure, "items": items}


# ─── Broşürler ──────────────────────────────────────────────────────────

def add_ocr(entry):
    """Resim broşürlere tesseract ile sayfa metni ekler; Şok'taki gibi içinde arama yapılabilsin.

    tesseract (GitHub'da kurulu) yoksa broşür metinsiz, sadece resim olarak kalır.
    """
    if not shutil.which("tesseract"):
        return entry
    texts = []
    for url in entry["images"]:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            img = r.read()
        # psm 11: afiş gibi dağınık yazılar için.
        out = subprocess.run(["tesseract", "stdin", "stdout", "-l", "tur", "--psm", "11"],
                             input=img, check=True, capture_output=True).stdout
        texts.append(" ".join(out.decode("utf-8", "replace").split()))
    entry["texts"] = texts
    return entry


def scrape_cagdas():
    page = http("https://www.cagdasmarketler.com/tr")
    imgs = [u.strip() for u in re.findall(r'src="(https://www\.cagdasmarketler\.com/images/uploads/(?:Indirimler|Firsatlar)/[^"]+)"', page)]
    imgs = list(dict.fromkeys(imgs))
    # Haftalık indirim broşürü önce, fırsat afişleri sonra.
    imgs.sort(key=lambda u: 0 if "/Indirimler/" in u else 1)
    if not imgs:
        raise RuntimeError("çağdaş: görsel bulunamadı")
    return add_ocr({"name": "Çağdaş", "url": "https://www.cagdasmarketler.com/tr", "images": imgs})


SOK_FIRSATLAR = "https://kurumsal.sokmarket.com.tr/tr/firsatlar"
SOK_CARD = re.compile(
    r'<a href="(/uploads/pdf/[^"]+)"[^>]*bc-aktual-card.*?aktual-card-title[^>]*>(.*?)</h3>'
    r'.*?aktual-card-date[^>]*>([^<]+)<.*?<img src="([^"]+)"', re.S)


def range_end(label, today):
    """'14 - 20 Ekim 2026' / '28 Ekim - 3 Kasım 2026' -> bitiş tarihi."""
    m = re.search(r"-\s*(\d+)\s+(\w+)", label)
    if not m or m.group(2).lower() not in TR_MONTHS:
        return None
    return aktuel_dates(f"{m.group(1)} {m.group(2)}", today)[1]


def scrape_sok(out_dir):
    """Şok 'Haftanın / Hafta Sonu Fırsatları' PDF broşürleri.

    PDF'ler 15-20 MB; telefonda zahmetli olmasın diye sayfalar pdftoppm ile
    küçük JPEG'lere çevrilir (GitHub'da kurulu). pdftoppm yoksa sadece kapak görseli
    ve PDF bağlantısı verilir.
    """
    today = datetime.now(TR_TZ).date()
    base = "https://kurumsal.sokmarket.com.tr"
    result = []
    for pdf, title, date, cover in SOK_CARD.findall(http(SOK_FIRSATLAR)):
        title = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", title)).split())
        date = date.strip()
        end = range_end(date, today)
        if end and end < today:  # süresi geçmiş broşür
            continue
        entry = {"name": "Şok", "title": f"Şok {title}", "date": date, "url": SOK_FIRSATLAR,
                 "pdf": base + pdf, "images": [base + cover]}
        if shutil.which("pdftoppm"):
            slug = re.sub(r"[^a-z0-9]+", "-", Path(pdf).stem.lower()).strip("-")
            sok_dir = Path(out_dir) / "sok"
            sok_dir.mkdir(parents=True, exist_ok=True)
            pdf_path = sok_dir / f"{slug}.pdf"
            req = urllib.request.Request(base + pdf, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                pdf_path.write_bytes(r.read())
            subprocess.run(["pdftoppm", "-jpeg", "-jpegopt", "quality=70", "-scale-to", "1500",
                            str(pdf_path), str(sok_dir / slug)], check=True)
            # Sayfa metinleri: uygulamada "aradığın ürün Şok broşürünün 3. sayfasında" diyebilmek için.
            text = subprocess.run(["pdftotext", "-enc", "UTF-8", str(pdf_path), "-"],
                                  check=True, capture_output=True, text=True, encoding="utf-8").stdout
            entry["texts"] = [" ".join(re.sub(r"/(\w)\.latn_\w+", r"\1", t).split()) for t in text.split("\f")]
            pdf_path.unlink()
            pages = sorted(sok_dir.glob(f"{slug}-*.jpg"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
            entry["images"] = [f"data/sok/{p.name}" for p in pages]
        result.append(entry)
    if not result:
        raise RuntimeError("şok: güncel broşür bulunamadı")
    return result


def scrape_anadolutat():
    page = http("https://www.anadolutat.com/kampanyalar")
    # Kampanyalar Next.js verisi içinde kaçışlı JSON olarak geliyor.
    ids = re.findall(r'\\"serverImageUrl\\":\\"(/api/serve-image\?id=[A-Za-z0-9_-]+)', page)
    imgs = ["https://www.anadolutat.com" + i for i in dict.fromkeys(ids)]
    if not imgs:
        raise RuntimeError("anadolu tat: kampanya görseli bulunamadı")
    return add_ocr({"name": "Anadolu Tat", "url": "https://www.anadolutat.com/kampanyalar", "images": imgs})


# ─── Ana akış ───────────────────────────────────────────────────────────

def run(name, fn, fallback):
    try:
        t = time.time()
        result = fn()
        log(f"✓ {name} ({time.time() - t:.0f} sn)")
        return result, True
    except Exception as e:  # noqa: BLE001 - bir kaynak düşerse diğerleri devam etsin
        log(f"✗ {name} HATA: {e!r} -> önceki veri kullanılıyor")
        return fallback, False


def load_previous(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="web/data")
    ap.add_argument("--previous", default="", help="bir önceki products.json (yedek için)")
    ap.add_argument("--previous-brochures", default="")
    ap.add_argument("--only", default="", help="test için: mf,yunus,aktuel,brochures (aktuel: BİM, A101, Yunus)")
    ap.add_argument("--reuse-today", action="store_true",
                    help="bugün zaten toplanmış kaynakları yeniden tarama (kod güncellemesinde sitelere yük olmasın)")
    ap.add_argument("--yunus-file", default="",
                    help="bilgisayardan gönderilen yunus.json; verilirse Yunus burada taranmaz (bkz. push_yunus.py)")
    args = ap.parse_args()

    prev = load_previous(args.previous) if args.previous else {}
    prev_b = load_previous(args.previous_brochures) if args.previous_brochures else {}
    prev_src = prev.get("sources", {})
    prev_br = {b["name"]: b for b in prev_b.get("brochures", [])}
    only = set(filter(None, args.only.split(",")))
    want = lambda k: not only or k in only  # noqa: E731

    now = datetime.now(TR_TZ).isoformat(timespec="minutes")
    ok, sources = {}, {}
    # Her kaynağın verisinin ne zaman toplandığı (yedek veri kullanılırsa eski tarih kalır).
    prev_stamps = prev.get("stamps", {})
    stamps = {}

    def collect(key, name, fn):
        if args.reuse_today and prev_src.get(key) and (prev_stamps.get(key) or "")[:10] == now[:10]:
            sources[key], ok[key], stamps[key] = prev_src[key], True, prev_stamps[key]
            log(f"↺ {name}: bugünkü veri yeniden kullanıldı ({stamps[key]})")
            return
        sources[key], ok[key] = run(name, fn, prev_src.get(key, []))
        stamps[key] = now if ok[key] else prev_stamps.get(key)

    if want("mf"):
        collect("mf", "marketfiyati", scrape_marketfiyati)
    # Yunus (yunusonline.com) ve Akakçe bulut sunucularını engelliyor; GitHub'da bu veriler
    # evdeki bilgisayarın gönderdiği yunus.json'dan gelir (push_yunus.py).
    y = load_previous(args.yunus_file) if args.yunus_file else {}
    if want("yunus"):
        if args.yunus_file:
            ok["yunus"] = bool(y.get("items"))
            sources["yunus"] = y["items"] if ok["yunus"] else prev_src.get("yunus", [])
            stamps["yunus"] = y["updated"] if ok["yunus"] else prev_stamps.get("yunus")
            log(f"yunus dosyadan: {len(sources['yunus'])} ürün ({stamps['yunus']})")
        else:
            collect("yunus", "yunus", scrape_yunus)
    if want("aktuel"):
        collect("aktuel", "BİM aktüel", scrape_bim_aktuel)
        collect("a101_aktuel", "A101 aktüel", scrape_a101_aktuel)
        if args.yunus_file:
            ok["yunus_aktuel"] = "aktuel" in y
            sources["yunus_aktuel"] = y["aktuel"] if ok["yunus_aktuel"] else prev_src.get("yunus_aktuel", [])
            stamps["yunus_aktuel"] = y["updated"] if ok["yunus_aktuel"] else prev_stamps.get("yunus_aktuel")
            log(f"yunus aktüel dosyadan: {len(sources['yunus_aktuel'])} ürün")
        else:
            collect("yunus_aktuel", "Yunus aktüel", lambda: yunus_aktuel()["items"])

    brochures = []
    if want("brochures"):
        for name, fn in (("Çağdaş", scrape_cagdas), ("Anadolu Tat", scrape_anadolutat),
                         ("Yunus", lambda: yunus_aktuel()["brochure"])):
            if name == "Yunus" and args.yunus_file:
                b, ok[name] = y.get("brochure") or prev_br.get(name), bool(y.get("brochure"))
            else:
                b, ok[name] = run(name, fn, prev_br.get(name))
            if b:
                brochures.append(b)
        # Şok'un sayfa görselleri her yayında yeniden üretilir; çökerse önceki gün verisi
        # işe yaramaz (görseller yok), o yüzden yedeği yok.
        sok, ok["Şok"] = run("Şok broşür", lambda: scrape_sok(args.out), [])
        brochures.extend(sok)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "products.json").write_text(
        json.dumps({"updated": now, "ok": ok, "stamps": stamps, "sources": sources}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (out / "brochures.json").write_text(
        json.dumps({"updated": now, "brochures": brochures}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    log("bitti:", {k: len(v) for k, v in sources.items()}, ok)
    # Hiçbir ürün yoksa yayınlama (boş uygulama göstermektense eskisi kalsın).
    if not any(sources.values()):
        sys.exit(1)


if __name__ == "__main__":
    main()
