"""Market Sepeti veri toplayıcı.

Her gün GitHub Actions'ta çalışır ve web/data/ altına iki dosya yazar:
  products.json  - aranabilir ürünler ve market fiyatları
  brochures.json - Çağdaş ve Anadolu Tat haftalık broşür görselleri

Kaynaklar:
  marketfiyati.org.tr (TÜBİTAK) -> A101, BİM, Şok, Migros, CarrefourSA, Tarım Kredi
  yunusonline.com               -> Yunus Market
  cagdasmarketler.com           -> Çağdaş broşürü (görsel)
  anadolutat.com/kampanyalar    -> Anadolu Tat fırsatları (görsel)

Bir kaynak çökerse, o kaynağın bir önceki günkü verisi (--previous) korunur.
Sadece standart kütüphane kullanılır.
"""

import argparse
import html
import http.client as http_client
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Annemin konumu: Çankaya / Kızılay merkezi. Yarıçap km.
LAT, LON, DISTANCE_KM = 39.9208, 32.8541, 5

MF_API = "https://api.marketfiyati.org.tr"
MF_MARKETS = {"a101", "bim", "sok", "migros", "carrefour", "tarim_kredi"}
MF_PAGE_SIZE = 25  # sunucu 25'in üstünü sessizce 25'e indiriyor
YUNUS = "https://yunusonline.com"

UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36"
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
        time.sleep(5 * (attempt + 1))


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
    subs = [sub for cat in cats for sub in cat["subcategories"]]
    products, failed = {}, []
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
                time.sleep(0.4)
                if not content or seen >= total:
                    break
                page += 1
            log(f"  {sub}: {seen}")
        except Exception as e:  # noqa: BLE001 - bir kategori düşerse diğerleri devam etsin
            failed.append(sub)
            log(f"  {sub}: HATA {e!r}")
            time.sleep(10)
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


def yunus_category(path, products):
    page, prev_hrefs = 1, None
    while page <= 50:
        url = f"{YUNUS}{path}?p=x[{page}]-o[1]"
        cards = YUNUS_CARD.findall(http(url))
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
    """'PINAR SÜT 1 LT' -> 'Pınar Süt 1 Lt' (Türkçe büyük/küçük harf kuralıyla)."""
    def word(w):
        if not w:
            return w
        first, rest = w[0], w[1:]
        rest = rest.replace("I", "ı").replace("İ", "i").lower()
        return first + rest
    return " ".join(word(w) for w in s.strip().split())


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


# ─── Broşürler ──────────────────────────────────────────────────────────

def scrape_cagdas():
    page = http("https://www.cagdasmarketler.com/tr")
    imgs = [u.strip() for u in re.findall(r'src="(https://www\.cagdasmarketler\.com/images/uploads/(?:Indirimler|Firsatlar)/[^"]+)"', page)]
    imgs = list(dict.fromkeys(imgs))
    # Haftalık indirim broşürü önce, fırsat afişleri sonra.
    imgs.sort(key=lambda u: 0 if "/Indirimler/" in u else 1)
    if not imgs:
        raise RuntimeError("çağdaş: görsel bulunamadı")
    return {"name": "Çağdaş", "url": "https://www.cagdasmarketler.com/tr", "images": imgs}


def scrape_anadolutat():
    page = http("https://www.anadolutat.com/kampanyalar")
    # Kampanyalar Next.js verisi içinde kaçışlı JSON olarak geliyor.
    ids = re.findall(r'\\"serverImageUrl\\":\\"(/api/serve-image\?id=[A-Za-z0-9_-]+)', page)
    imgs = ["https://www.anadolutat.com" + i for i in dict.fromkeys(ids)]
    if not imgs:
        raise RuntimeError("anadolu tat: kampanya görseli bulunamadı")
    return {"name": "Anadolu Tat", "url": "https://www.anadolutat.com/kampanyalar", "images": imgs}


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
    ap.add_argument("--only", default="", help="test için: mf,yunus,brochures")
    args = ap.parse_args()

    prev = load_previous(args.previous) if args.previous else {}
    prev_b = load_previous(args.previous_brochures) if args.previous_brochures else {}
    prev_src = prev.get("sources", {})
    prev_br = {b["name"]: b for b in prev_b.get("brochures", [])}
    only = set(filter(None, args.only.split(",")))
    want = lambda k: not only or k in only  # noqa: E731

    ok = {}
    sources = {}
    if want("mf"):
        sources["mf"], ok["mf"] = run("marketfiyati", scrape_marketfiyati, prev_src.get("mf", []))
    if want("yunus"):
        sources["yunus"], ok["yunus"] = run("yunus", scrape_yunus, prev_src.get("yunus", []))

    brochures = []
    if want("brochures"):
        for name, fn in (("Çağdaş", scrape_cagdas), ("Anadolu Tat", scrape_anadolutat)):
            b, ok[name] = run(name, fn, prev_br.get(name))
            if b:
                brochures.append(b)

    now = datetime.now(TR_TZ).isoformat(timespec="minutes")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "products.json").write_text(
        json.dumps({"updated": now, "ok": ok, "sources": sources}, ensure_ascii=False, separators=(",", ":")),
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
