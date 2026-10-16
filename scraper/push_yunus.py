"""Yunus fiyatlarını bu bilgisayardan toplayıp GitHub'a gönderir.

Yunus Online ve Yunus aktüel paylaşımlarını toplayan Akakçe, GitHub'ın (yurt dışındaki)
sunucularına yanıt vermiyor; bu yüzden tarama Türkiye'deki bu bilgisayarda yapılır. Sonuç, repodaki `yunus-data`
dalına tek dosya (yunus.json) olarak gönderilir. Dalın geçmişi her seferinde
sıfırlanır, repo şişmez. Günlük GitHub çalıştırması bu dosyayı alıp birleştirir.

Windows Görev Zamanlayıcı her sabah çalıştırır (kurulum: install_task.ps1).
Kayıt dosyası: %LOCALAPPDATA%\\MarketSepeti\\yunus.log
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

BRANCH = "yunus-data"
HERE = Path(__file__).resolve().parent


def main():
    log_dir = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "MarketSepeti"
    log_dir.mkdir(parents=True, exist_ok=True)
    # Görev penceresiz (pythonw) çalışır; çıktılar dosyaya gider.
    sys.stdout = sys.stderr = open(log_dir / "yunus.log", "w", encoding="utf-8", buffering=1)

    sys.path.insert(0, str(HERE))
    import scrape

    scrape.log("başladı:", datetime.now().isoformat(timespec="seconds"))
    items = scrape.scrape_yunus()
    payload = {"updated": datetime.now(scrape.TR_TZ).isoformat(timespec="minutes"), "items": items}
    # Yunus aktüel (Akakçe) de bulut sunucularını engelliyor; onu da buradan gönderiyoruz.
    try:
        akt = scrape.yunus_aktuel()
        payload["aktuel"], payload["brochure"] = akt["items"], akt["brochure"]
    except Exception as e:  # noqa: BLE001 - aktüel alınamazsa katalog yine gönderilsin
        scrape.log("yunus aktüel alınamadı:", repr(e))
    repo_url = subprocess.run(["git", "-C", str(HERE), "remote", "get-url", "origin"],
                              check=True, capture_output=True, text=True).stdout.strip()

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        Path(d, "yunus.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                                         encoding="utf-8")

        def git(*args):
            subprocess.run(["git", "-C", d, *args], check=True)

        git("init", "-q", "-b", BRANCH)
        git("add", "yunus.json")
        git("-c", "user.name=Market Sepeti", "-c", "user.email=market-sepeti@users.noreply.github.com",
            "commit", "-q", "-m", f"Yunus fiyatları ({len(items)} ürün)")
        git("push", "-q", "--force", repo_url, f"{BRANCH}:{BRANCH}")
    scrape.log("gönderildi:", len(items), "ürün")


if __name__ == "__main__":
    main()
