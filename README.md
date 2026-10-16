# Market Sepeti

Ankara (Çankaya) marketlerinde fiyat karşılaştırıp alışveriş listesi hazırlamak için sade bir telefon uygulaması.

- **Ara:** "süt" yaz (veya 🎤 ile söyle), marketlerdeki fiyatlar en ucuzdan pahalıya listelenir. "Ekle" ile sepete at.
- **Sepetim:** Ürünler market market gruplanır. Alınanları ✓ ile işaretle, listeyi WhatsApp'la gönder.
- **Aktüel:** BİM ve A101 aktüel ürünleri (tarih / kampanya bölümleriyle, sepete eklenebilir), Şok / Çağdaş / Anadolu Tat broşürleri.
  Üstteki kutudan aktüelde arama yapılır; ana aramada ürün aktüeldeyse "Aktüelde de var" kutusu çıkar.
- **Takip:** Ürün kartındaki 🔔 ile hedef fiyat belirlenir. Fiyat herhangi bir markette ya da BİM aktüelde
  hedefe inince telefona bildirim gelir (uygulama açılınca ve, ana ekrana eklenmişse, Chrome'un günlük
  arka plan kontrolüyle). Takip listesi sadece o telefonda tutulur.

## Veri kaynakları

| Market | Kaynak |
|---|---|
| A101, BİM, Şok, Migros, CarrefourSA, Tarım Kredi | [marketfiyati.org.tr](https://marketfiyati.org.tr) (TÜBİTAK), Kızılay çevresi 5 km'deki şubeler |
| Yunus | [yunusonline.com](https://yunusonline.com) — site yurt dışından (GitHub) gelen bağlantıları kestiği için tam katalog evdeki bilgisayardan gönderilir (`scraper/push_yunus.py`) |
| Yunus aktüel | [Akakçe Yunus broşürleri](https://www.akakce.com/brosurler/yunusmarket) — haftalık paylaşımların sayfa görselleri ve broşürdeki ürünlerin adı/fiyatı |
| A101 aktüel | A101'in kendi API'si (rio.a101.com.tr): "Aldın Aldın" (Z110) ve "Haftanın Yıldızları" (Z100) kampanyaları |
| BİM aktüel | [bim.com.tr aktüel ürünler](https://www.bim.com.tr/Categories/100/aktuel-urunler.aspx) |
| Şok broşürü | [kurumsal.sokmarket.com.tr/tr/firsatlar](https://kurumsal.sokmarket.com.tr/tr/firsatlar) (PDF → sayfa resimleri + aranabilir metin) |
| Çağdaş | [cagdasmarketler.com](https://www.cagdasmarketler.com/tr) haftalık broşür (sadece görsel) |
| Anadolu Tat | [anadolutat.com/kampanyalar](https://www.anadolutat.com/kampanyalar) (sadece görsel) |

Fiyatlar her gün 09:00'da GitHub Actions ile otomatik toplanır ve GitHub Pages'e yayınlanır
(`.github/workflows/update.yml`). Bir kaynak o gün çalışmazsa bir önceki günün verisi korunur.
Elle güncellemek için: GitHub → Actions → "Fiyatları güncelle ve yayınla" → **Run workflow**.

## Telefona kurulum (Samsung / Android)

1. Chrome'da uygulama adresini aç.
2. Üstteki **Ana ekrana ekle** butonuna (yoksa Chrome menüsü ⋮ → **Uygulamayı yükle**) dokun.
3. Uygulama, normal bir uygulama gibi ana ekrana ve uygulama listesine eklenir.
   Kodda yapılan her değişiklik, uygulama bir sonraki açılışında kendiliğinden gelir.

## Geliştirme

```bash
python scraper/scrape.py --out web/data   # veriyi topla (~30 dk)
python -m http.server -d web 8000         # http://localhost:8000
```

Konumu değiştirmek için `scraper/scrape.py` içindeki `LAT, LON, DISTANCE_KM` değerlerini düzenle.
