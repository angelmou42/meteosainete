"""Verificación de la lluvia prevista por cada modelo frente a la lluvia medida.

Compara, día a día, la lluvia que cada modelo predijo con 1 y 3 días de
antelación con la lluvia que midieron tres estaciones de AEMET cercanas a
Arjona (Jaén, Córdoba y Granada) durante un año.

Fuentes (gratuitas y sin clave):
  - Predicciones pasadas: API "Previous Runs" de Open-Meteo. La variable
    precipitation_previous_dayN es lo que el modelo predijo N días antes.
  - Observaciones: datos diarios de Meteostat (que recoge los partes SYNOP de
    las estaciones de AEMET).

Uso:  python analisis/verificacion_lluvia.py
Las descargas se guardan en analisis/datos/ para no repetirlas.
"""

import csv
import gzip
import io
import json
import random
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

# ---------- Configuración ----------

# Periodo: el último año con observaciones publicadas en Meteostat.
START = date(2025, 3, 12)
END = date(2026, 3, 11)

STATIONS = {
    "08417": ("Jaén", 37.7833, -3.8),
    "08410": ("Córdoba", 37.85, -4.85),
    "08419": ("Granada", 37.1833, -3.7833),
}

MODELS = {
    "ecmwf_ifs025": "ECMWF",
    "gfs_seamless": "GFS",
    "icon_seamless": "ICON",
    "meteofrance_seamless": "Météo-France",
    "ukmo_seamless": "UKMO",
    "gem_seamless": "GEM",
}

LEADS = [1, 3]       # días de antelación de la predicción
BOOTSTRAP = 1000     # remuestreos para estimar el margen de error
RAIN_MM = 1.0        # a partir de cuántos mm diarios consideramos "día de lluvia"
DATA_DIR = Path(__file__).parent / "datos"


# ---------- Descargas (con caché en disco) ----------

def download(url: str, path: Path) -> bytes:
    if not path.exists():
        DATA_DIR.mkdir(exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as r:
            path.write_bytes(r.read())
    return path.read_bytes()


def observed_rain(station: str) -> dict[date, float]:
    """Lluvia diaria medida (mm) por fecha. Columnas de Meteostat: fecha, tavg, tmin, tmax, prcp…"""
    raw = download(f"https://bulk.meteostat.net/v2/daily/{station}.csv.gz", DATA_DIR / f"obs_{station}.csv.gz")
    rain = {}
    for row in csv.reader(io.StringIO(gzip.decompress(raw).decode())):
        day = date.fromisoformat(row[0])
        if START <= day <= END and row[4] != "":
            rain[day] = float(row[4])
    return rain


def forecast_hourly(station: str, lat: float, lon: float) -> dict:
    """Lluvia horaria prevista (UTC) por cada modelo y antelación."""
    variables = ",".join(f"precipitation_previous_day{n}" for n in LEADS)
    params = urllib.parse.urlencode({
        "latitude": lat, "longitude": lon,
        "hourly": variables,
        "models": ",".join(MODELS),
        "start_date": START - timedelta(days=2),  # días extra para poder desplazar la ventana diaria
        "end_date": END + timedelta(days=2),
        "timezone": "GMT",
    })
    raw = download("https://previous-runs-api.open-meteo.com/v1/forecast?" + params, DATA_DIR / f"pred_{station}.json")
    return json.loads(raw)["hourly"]


# ---------- De horas a días ----------

def daily_sums(times: list[str], values: list, start_hour: int, shift: int) -> dict[date, float | None]:
    """Suma la lluvia horaria en "días" de 24 h que empiezan a `start_hour` (UTC).

    Cada día se etiqueta con la fecha en que empieza más `shift` días. Así se
    pueden probar las distintas convenciones de las estaciones (día natural,
    de 06 a 06 UTC, de 07 a 07…) y quedarse con la que encaja con los datos.
    Si falta alguna hora, el día queda como None (sin datos).
    """
    sums: dict[date, list] = {}
    for t, v in zip(times, values):
        # El valor con marca 07:00 es la lluvia caída entre las 06 y las 07: por eso el -1 h.
        start_of_hour = datetime.fromisoformat(t) - timedelta(hours=1)
        day = (start_of_hour - timedelta(hours=start_hour)).date() + timedelta(days=shift)
        sums.setdefault(day, []).append(v)
    return {d: (None if None in vs or len(vs) < 24 else sum(vs)) for d, vs in sums.items()}


# ---------- Métricas ----------

def scores(pairs: list[tuple]) -> dict:
    """Tabla de contingencia lluvia / no lluvia y métricas habituales.

    acierto:     % de días en los que acertó si llovía o no
    deteccion:   de los días que llovió, % que el modelo había avisado (POD)
    falsas:      de los días que el modelo avisó, % en los que no llovió (FAR)
    heidke:      acierto descontando el que se lograría por azar (0 = como el azar, 1 = perfecto)
    error_mm:    error medio absoluto en mm
    """
    hits = sum(1 for p, o, *_ in pairs if p >= RAIN_MM and o >= RAIN_MM)
    false_alarms = sum(1 for p, o, *_ in pairs if p >= RAIN_MM and o < RAIN_MM)
    misses = sum(1 for p, o, *_ in pairs if p < RAIN_MM and o >= RAIN_MM)
    dry_ok = len(pairs) - hits - false_alarms - misses
    n = len(pairs)
    expected = ((hits + misses) * (hits + false_alarms) + (dry_ok + misses) * (dry_ok + false_alarms)) / n
    return {
        "dias": n,
        "acierto": 100 * (hits + dry_ok) / n,
        "deteccion": 100 * hits / (hits + misses) if hits + misses else float("nan"),
        "falsas": 100 * false_alarms / (hits + false_alarms) if hits + false_alarms else float("nan"),
        "heidke": (hits + dry_ok - expected) / (n - expected) if n != expected else float("nan"),
        "error_mm": statistics.mean(abs(p - o) for p, o, *_ in pairs),
    }


def heidke_interval(pairs: list[tuple]) -> tuple[float, float]:
    """Intervalo del 90 % del índice de Heidke por remuestreo (bootstrap).

    Se remuestrean fechas, no pares sueltos, porque el mismo día suele llover
    o no en las tres estaciones a la vez: tratarlos como independientes daría
    un margen de error falsamente pequeño.
    """
    by_date: dict[date, list] = {}
    for pair in pairs:
        by_date.setdefault(pair[2], []).append(pair)
    dates = list(by_date)
    rng = random.Random(42)  # semilla fija: mismos resultados en cada ejecución
    values = []
    for _ in range(BOOTSTRAP):
        sample = [p for d in rng.choices(dates, k=len(dates)) for p in by_date[d]]
        values.append(scores(sample)["heidke"])
    values.sort()
    return values[int(0.05 * BOOTSTRAP)], values[int(0.95 * BOOTSTRAP) - 1]


def correlation(pairs: list[tuple]) -> float:
    return statistics.correlation([p[0] for p in pairs], [p[1] for p in pairs])


# ---------- Programa principal ----------

def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # para que la consola de Windows muestre tildes y símbolos
    obs = {s: observed_rain(s) for s in STATIONS}
    hourly = {s: forecast_hourly(s, lat, lon) for s, (_, lat, lon) in STATIONS.items()}

    # 1) ¿Qué horas abarca el "día" de las observaciones? Lo comprobamos con los datos:
    #    la definición que mejor correlaciona con lo medido es la que usan las estaciones.
    # Cada par es (lluvia prevista, lluvia medida, fecha).
    def pairs_for(model: str, lead: int, window: tuple[int, int]) -> list[tuple]:
        out = []
        for s in STATIONS:
            h = hourly[s]
            daily = daily_sums(h["time"], h[f"precipitation_previous_day{lead}_{model}"], *window)
            out += [(daily[d], o, d) for d, o in obs[s].items() if daily.get(d) is not None]
        return out

    candidates = [(0, 0), (0, -1), (0, 1), (6, 0), (6, -1), (7, 0), (7, -1)]
    print("Correlación ECMWF (1 día) con lo medido según cómo se define el día:")
    for c in candidates:
        r = correlation(pairs_for("ecmwf_ifs025", 1, c))
        print(f"  empieza a las {c[0]:02d} UTC, etiqueta desplazada {c[1]:+d} día: r = {r:.3f}")
    window = max(candidates, key=lambda c: correlation(pairs_for("ecmwf_ifs025", 1, c)))
    print(f"Se usa: empieza a las {window[0]:02d} UTC, desplazada {window[1]:+d} día.\n")

    rows = []
    for lead in LEADS:
        per_model = {m: pairs_for(m, lead, window) for m in MODELS}

        # Consenso: mediana de los modelos con datos ese día (lo que muestra la web).
        consensus = []
        for s in STATIONS:
            h = hourly[s]
            dailies = [daily_sums(h["time"], h[f"precipitation_previous_day{lead}_{m}"], *window) for m in MODELS]
            for d, o in obs[s].items():
                vals = [dd[d] for dd in dailies if dd.get(d) is not None]
                if len(vals) >= 4:
                    consensus.append((statistics.median(vals), o, d))

        always_dry = [(0.0, o, d) for _, o, d in consensus]
        for key, name, pairs in [*((m, MODELS[m], p) for m, p in per_model.items()),
                                 ("consenso", "Consenso (mediana)", consensus),
                                 ("siempre_seco", "Referencia: «siempre seco»", always_dry)]:
            low, high = heidke_interval(pairs)
            rows.append({"antelacion": lead, "id": key, "modelo": name, **scores(pairs),
                         "heidke_min90": low, "heidke_max90": high})

    # Tabla en pantalla, CSV con todos los números y JSON para la web.
    rainy = sum(1 for s in STATIONS for o in obs[s].values() if o >= RAIN_MM)
    total = sum(len(obs[s]) for s in STATIONS)
    print(f"Días con lluvia (≥ {RAIN_MM:g} mm) medidos: {rainy} de {total} ({100 * rainy / total:.0f} %)\n")
    for lead in LEADS:
        print(f"== Predicción hecha {lead} día(s) antes ==")
        print(f"{'Modelo':28} {'Días':>5} {'Acierto':>8} {'Detecta':>8} {'F. alarma':>9} {'Heidke (margen 90 %)':>21} {'Error mm':>9}")
        for r in (r for r in rows if r["antelacion"] == lead):
            print(f"{r['modelo']:28} {r['dias']:5d} {r['acierto']:7.1f}% {r['deteccion']:7.1f}% "
                  f"{r['falsas']:8.1f}% {r['heidke']:7.2f} ({r['heidke_min90']:.2f}–{r['heidke_max90']:.2f}) {r['error_mm']:9.2f}")
        print()

    out = Path(__file__).parent / "resultados.csv"
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows({k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()} for r in rows)
    print(f"Resultados guardados en {out}")

    # JSON que lee la pestaña "Acierto" de la web (NaN no es JSON válido: pasa a null).
    clean = lambda v: None if isinstance(v, float) and v != v else (round(v, 3) if isinstance(v, float) else v)
    summary = {
        "periodo": [START.isoformat(), END.isoformat()],
        "estaciones": [{"nombre": n, "lat": la, "lon": lo} for n, la, lo in STATIONS.values()],
        "umbral_mm": RAIN_MM,
        "dias": total,
        "dias_lluvia": rainy,
        "resultados": [{k: clean(v) for k, v in r.items()} for r in rows],
    }
    out = Path(__file__).parent / "resultados.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Resumen para la web guardado en {out}")


if __name__ == "__main__":
    main()
