"""Sube el número de versión de los archivos de la web en un solo paso.

Cambia ?v=N por ?v=N+1 en index.html (CSS, JS y mapa de importación), el
nombre de la caché del service worker (sw.js) y la mención del README. Hay que
ejecutarlo antes de publicar un cambio en CSS o JS, para que los navegadores
no mezclen archivos nuevos con copias viejas en caché.

Uso:  python herramientas/subir_version.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    index = ROOT / "index.html"
    html = index.read_text(encoding="utf-8")
    versions = {int(v) for v in re.findall(r"\?v=(\d+)", html)}
    if len(versions) != 1:
        raise SystemExit(f"index.html tiene versiones distintas: {sorted(versions)}")
    old = versions.pop()
    new = old + 1

    index.write_text(html.replace(f"?v={old}", f"?v={new}"), encoding="utf-8")
    for name, before, after in [
        ("sw.js", f'"meteosainete-v{old}"', f'"meteosainete-v{new}"'),
        ("README.md", f"style.css?v={old}", f"style.css?v={new}"),
    ]:
        path = ROOT / name
        text = path.read_text(encoding="utf-8")
        if before not in text:
            raise SystemExit(f"{name}: no encuentro {before}")
        path.write_text(text.replace(before, after), encoding="utf-8")
    print(f"Versión {old} → {new}")


if __name__ == "__main__":
    main()
