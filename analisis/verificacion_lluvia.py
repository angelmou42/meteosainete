"""Verificación de la lluvia prevista por cada modelo frente a la lluvia medida.

Compara, día a día, la lluvia que cada modelo predijo con 1 y 3 días de
antelación con la lluvia que midieron 48 estaciones de AEMET repartidas por
13 zonas de España durante un año. Los resultados se dan por zona y para toda
España, porque el modelo que mejor acierta no tiene por qué ser el mismo en
Galicia que en Murcia.

Fuentes (gratuitas y sin clave):
  - Predicciones pasadas: API "Previous Runs" de Open-Meteo. La variable
    precipitation_previous_dayN es lo que el modelo predijo N días antes.
  - Observaciones: datos diarios de Meteostat (que recoge los partes SYNOP de
    las estaciones de AEMET).

Uso:  python analisis/verificacion_lluvia.py
Las descargas se guardan en analisis/datos/ para no repetirlas. La primera
vez tarda unos minutos: se espera entre descargas para no pasar del límite
por minuto de Open-Meteo.
"""

import csv
import gzip
import io
import json
import random
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

# ---------- Configuración ----------

# Periodo: el último año con observaciones publicadas en Meteostat.
START = date(2025, 3, 12)
END = date(2026, 3, 11)

# Zonas con clima parecido y sus estaciones (código OMM: nombre, latitud, longitud).
REGIONS = {
    "galicia": ("Galicia", {
        "08001": ("A Coruña", 43.367, -8.417), "08042": ("Santiago", 42.9, -8.433),
        "08045": ("Vigo", 42.217, -8.633), "08048": ("Ourense", 42.333, -7.867)}),
    "cantabrico": ("Cantábrico", {
        "08011": ("Avilés", 43.55, -6.033), "08021": ("Santander", 43.433, -3.817),
        "08025": ("Bilbao", 43.3, -2.933), "08027": ("San Sebastián", 43.3, -2.05)}),
    "meseta_norte": ("Castilla y León", {
        "08055": ("León", 42.583, -5.65), "08075": ("Burgos", 42.367, -3.633),
        "08141": ("Valladolid", 41.65, -4.767), "08202": ("Salamanca", 40.95, -5.5)}),
    "ebro": ("Valle del Ebro y Navarra", {
        "08084": ("Logroño", 42.45, -2.333), "08085": ("Pamplona", 42.767, -1.633),
        "08160": ("Zaragoza", 41.667, -1.017), "08171": ("Lleida", 41.617, 0.633)}),
    "cataluna": ("Cataluña", {
        "08181": ("Barcelona", 41.283, 2.067), "08184": ("Girona", 41.9, 2.767),
        "08175": ("Reus", 41.15, 1.167)}),
    "centro": ("Madrid y alrededores", {
        "08222": ("Madrid", 40.417, -3.683), "08226": ("Guadalajara", 40.667, -3.167),
        "08213": ("Segovia", 40.95, -4.117), "08210": ("Ávila", 40.65, -4.7)}),
    "la_mancha": ("Castilla-La Mancha", {
        "08272": ("Toledo", 39.883, -4.05), "08348": ("Ciudad Real", 38.983, -3.917),
        "08231": ("Cuenca", 40.067, -2.133), "08280": ("Albacete", 38.95, -1.85)}),
    "levante": ("Comunidad Valenciana y Murcia", {
        "08286": ("Castellón", 39.95, -0.067), "08285": ("Valencia", 39.483, -0.383),
        "08359": ("Alicante", 38.367, -0.5), "08430": ("Murcia", 38.0, -1.167)}),
    "extremadura": ("Extremadura", {
        "08261": ("Cáceres", 39.467, -6.333), "08330": ("Badajoz", 38.883, -6.817)}),
    "andalucia_occidental": ("Andalucía occidental", {
        "08391": ("Sevilla", 37.417, -5.9), "08383": ("Huelva", 37.283, -6.917),
        "08451": ("Jerez", 36.75, -6.067), "08482": ("Málaga", 36.667, -4.483)}),
    "andalucia_oriental": ("Andalucía oriental", {
        "08417": ("Jaén", 37.783, -3.8), "08410": ("Córdoba", 37.85, -4.85),
        "08419": ("Granada", 37.183, -3.783), "08487": ("Almería", 36.85, -2.383)}),
    "baleares": ("Baleares", {
        "08306": ("Palma", 39.55, 2.733), "08314": ("Menorca", 39.867, 4.233),
        "08373": ("Ibiza", 38.867, 1.383)}),
    "canarias": ("Canarias", {
        "60015": ("Tenerife Norte", 28.467, -16.317), "60025": ("Tenerife Sur", 28.05, -16.567),
        "60030": ("Gran Canaria", 27.933, -15.383), "60040": ("Lanzarote", 28.95, -13.6)}),
}

# Todas las estaciones juntas (las usa también consenso_ponderado.py).
STATIONS = {sid: info for _, stations in REGIONS.values() for sid, info in stations.items()}

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
PAUSE_S = 4          # espera entre descargas de Open-Meteo (cada una cuenta como ~30 llamadas)


# ---------- Descargas (con caché en disco) ----------

def download(url: str, path: Path, pause: float = 0) -> bytes:
    """Descarga una vez y guarda en disco. Si la API pide esperar (429), espera y reintenta."""
    if not path.exists():
        DATA_DIR.mkdir(exist_ok=True)
        for attempt in range(5):
            time.sleep(pause)
            try:
                with urllib.request.urlopen(url, timeout=180) as r:
                    path.write_bytes(r.read())
                break
            except urllib.error.HTTPError as err:
                if err.code != 429 or attempt == 4:
                    raise
                print("  Open-Meteo pide esperar: 65 s…")
                time.sleep(65)
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
    path = DATA_DIR / f"pred_{station}.json"
    raw = download("https://previous-runs-api.open-meteo.com/v1/forecast?" + params, path, 0 if path.exists() else PAUSE_S)
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

def heidke_from_counts(hits: int, false_alarms: int, misses: int, dry_ok: int) -> float:
    """Índice de Heidke: acierto descontando el que se lograría por azar (0 = como el azar, 1 = perfecto)."""
    n = hits + false_alarms + misses + dry_ok
    expected = ((hits + misses) * (hits + false_alarms) + (dry_ok + misses) * (dry_ok + false_alarms)) / n
    return (hits + dry_ok - expected) / (n - expected) if n != expected else float("nan")


def counts(pairs: list[tuple]) -> tuple[int, int, int, int]:
    """Tabla de contingencia: (aciertos de lluvia, falsas alarmas, fallos, aciertos de seco)."""
    hits = sum(1 for p, o, *_ in pairs if p >= RAIN_MM and o >= RAIN_MM)
    false_alarms = sum(1 for p, o, *_ in pairs if p >= RAIN_MM and o < RAIN_MM)
    misses = sum(1 for p, o, *_ in pairs if p < RAIN_MM and o >= RAIN_MM)
    return hits, false_alarms, misses, len(pairs) - hits - false_alarms - misses


def scores(pairs: list[tuple]) -> dict:
    """Tabla de contingencia lluvia / no lluvia y métricas habituales.

    acierto:     % de días en los que acertó si llovía o no
    deteccion:   de los días que llovió, % que el modelo había avisado (POD)
    falsas:      de los días que el modelo avisó, % en los que no llovió (FAR)
    heidke:      acierto descontando el que se lograría por azar (0 = como el azar, 1 = perfecto)
    error_mm:    error medio absoluto en mm
    """
    hits, false_alarms, misses, dry_ok = counts(pairs)
    n = len(pairs)
    return {
        "dias": n,
        "acierto": 100 * (hits + dry_ok) / n,
        "deteccion": 100 * hits / (hits + misses) if hits + misses else float("nan"),
        "falsas": 100 * false_alarms / (hits + false_alarms) if hits + false_alarms else float("nan"),
        "heidke": heidke_from_counts(hits, false_alarms, misses, dry_ok),
        "error_mm": statistics.mean(abs(p - o) for p, o, *_ in pairs),
    }


def heidke_interval(pairs: list[tuple]) -> tuple[float, float]:
    """Intervalo del 90 % del índice de Heidke por remuestreo (bootstrap).

    Se remuestrean fechas, no pares sueltos, porque el mismo día suele llover
    o no en las estaciones cercanas a la vez: tratarlos como independientes
    daría un margen de error falsamente pequeño. Para que sea rápido, primero
    se cuenta la tabla de contingencia de cada fecha y luego solo se suman.
    """
    by_date: dict[date, list] = {}
    for pair in pairs:
        by_date.setdefault(pair[2], []).append(pair)
    per_date = [counts(ps) for ps in by_date.values()]
    rng = random.Random(42)  # semilla fija: mismos resultados en cada ejecución
    values = []
    for _ in range(BOOTSTRAP):
        total = [0, 0, 0, 0]
        for c in rng.choices(per_date, k=len(per_date)):
            for k in range(4):
                total[k] += c[k]
        h = heidke_from_counts(*total)
        if h == h:  # sin NaN (puede salir si en la muestra no hay ningún día de lluvia)
            values.append(h)
    if not values:
        return float("nan"), float("nan")
    values.sort()
    return values[int(0.05 * len(values))], values[int(0.95 * len(values)) - 1]


def correlation(pairs: list[tuple]) -> float:
    return statistics.correlation([p[0] for p in pairs], [p[1] for p in pairs])


# ---------- Programa principal ----------

def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # para que la consola de Windows muestre tildes y símbolos
    print(f"Descargando datos de {len(STATIONS)} estaciones (solo la primera vez)…")
    obs = {s: observed_rain(s) for s in STATIONS}
    hourly = {}
    for k, (s, (name, lat, lon)) in enumerate(STATIONS.items(), 1):
        print(f"  {k}/{len(STATIONS)} {name}")
        hourly[s] = forecast_hourly(s, lat, lon)

    # Cada par es (lluvia prevista, lluvia medida, fecha) para las estaciones indicadas.
    def pairs_for(stations, model: str, lead: int, window: tuple[int, int]) -> list[tuple]:
        out = []
        for s in stations:
            h = hourly[s]
            daily = daily_sums(h["time"], h[f"precipitation_previous_day{lead}_{model}"], *window)
            out += [(daily[d], o, d) for d, o in obs[s].items() if daily.get(d) is not None]
        return out

    # 1) ¿Qué horas abarca el "día" de las observaciones? Lo comprobamos con los datos:
    #    la definición que mejor correlaciona con lo medido es la que usan las estaciones.
    candidates = [(0, 0), (0, -1), (0, 1), (6, 0), (6, -1), (7, 0), (7, -1)]
    corr = {c: correlation(pairs_for(STATIONS, "ecmwf_ifs025", 1, c)) for c in candidates}
    print("\nCorrelación ECMWF (1 día) con lo medido según cómo se define el día:")
    for c, r in corr.items():
        print(f"  empieza a las {c[0]:02d} UTC, etiqueta desplazada {c[1]:+d} día: r = {r:.3f}")
    window = max(candidates, key=corr.get)
    print(f"Se usa: empieza a las {window[0]:02d} UTC, desplazada {window[1]:+d} día.")

    # 2) Métricas por zona y para toda España.
    zones = [("espana", "Toda España", STATIONS), *((rid, name, st) for rid, (name, st) in REGIONS.items())]
    regions_out, csv_rows = [], []
    for rid, rname, stations in zones:
        rows = []
        for lead in LEADS:
            per_model = {m: pairs_for(stations, m, lead, window) for m in MODELS}

            # Consenso: mediana de los modelos con datos ese día (lo que muestra la web).
            consensus = []
            for s in stations:
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
                if not pairs:
                    continue
                low, high = heidke_interval(pairs)
                rows.append({"antelacion": lead, "id": key, "modelo": name, **scores(pairs),
                             "heidke_min90": low, "heidke_max90": high})

        rainy = sum(1 for s in stations for o in obs[s].values() if o >= RAIN_MM)
        total = sum(len(obs[s]) for s in stations)
        regions_out.append({
            "id": rid, "nombre": rname,
            "estaciones": [{"nombre": n, "lat": la, "lon": lo} for n, la, lo in stations.values()],
            "dias": total, "dias_lluvia": rainy, "resultados": rows,
        })
        csv_rows += [{"zona": rid, **r} for r in rows]

        # Resumen en pantalla: puntuación de Heidke con 1 día de antelación, de mejor a peor.
        lead1 = sorted((r for r in rows if r["antelacion"] == 1 and r["id"] != "siempre_seco"), key=lambda r: -r["heidke"])
        print(f"\n{rname}: {total} días, {rainy} con lluvia ({100 * rainy / max(total, 1):.0f} %)")
        print("  " + " · ".join(f"{r['modelo'].replace(' (mediana)', '')} {r['heidke']:.2f}" for r in lead1))

    out = Path(__file__).parent / "resultados.csv"
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=csv_rows[0].keys())
        w.writeheader()
        w.writerows({k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()} for r in csv_rows)
    print(f"\nResultados guardados en {out}")

    # JSON que lee la pestaña "Acierto" de la web (NaN no es JSON válido: pasa a null).
    clean = lambda v: None if isinstance(v, float) and v != v else (round(v, 3) if isinstance(v, float) else v)
    for region in regions_out:
        region["resultados"] = [{k: clean(v) for k, v in r.items()} for r in region["resultados"]]
    summary = {
        "periodo": [START.isoformat(), END.isoformat()],
        "umbral_mm": RAIN_MM,
        "ventana_utc": list(window),
        "regiones": regions_out,
    }
    out = Path(__file__).parent / "resultados.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Resumen para la web guardado en {out}")


if __name__ == "__main__":
    main()
