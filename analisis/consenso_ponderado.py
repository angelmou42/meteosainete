"""¿Mejora el consenso si los modelos que más aciertan pesan más?

Compara la mediana normal (todos los modelos pesan igual) con medianas
ponderadas según el acierto de cada modelo. Para que la prueba sea justa, los
pesos se calculan con una mitad de los datos y se evalúan con la otra
(validación cruzada por meses alternos): si se calcularan y evaluaran con los
mismos días, el ponderado siempre parecería mejor aunque no lo fuera.

Uso:  python analisis/consenso_ponderado.py   (reutiliza las descargas de verificacion_lluvia.py)
"""

import random
import statistics
import sys
from datetime import date

from verificacion_lluvia import (BOOTSTRAP, LEADS, MODELS, STATIONS, daily_sums, forecast_hourly,
                                 observed_rain, scores)

WINDOW = (6, 0)  # día de 06 a 06 UTC: la definición que mejor encaja con las estaciones (ver verificacion_lluvia.py)
POWERS = [1, 2, 4]  # peso = puntuación de Heidke elevada a esta potencia (más alta = premia más a los mejores)


def weighted_median(values: list[float], weights: list[float]) -> float:
    """Valor en el que el peso acumulado llega a la mitad del total."""
    pairs = sorted(zip(values, weights))
    half = sum(weights) / 2
    acc = 0.0
    for i, (v, w) in enumerate(pairs):
        acc += w
        if acc > half:
            return v
        if acc == half:  # justo en la mitad: media con el siguiente, como en la mediana normal
            return (v + pairs[i + 1][0]) / 2
    return pairs[-1][0]


def build_days(lead: int) -> list[dict]:
    """Una fila por estación y día: lluvia medida y lluvia prevista por cada modelo."""
    days = []
    for station, (_, lat, lon) in STATIONS.items():
        obs = observed_rain(station)
        hourly = forecast_hourly(station, lat, lon)
        daily = {m: daily_sums(hourly["time"], hourly[f"precipitation_previous_day{lead}_{m}"], *WINDOW) for m in MODELS}
        for d, o in obs.items():
            preds = {m: daily[m][d] for m in MODELS if daily[m].get(d) is not None}
            if len(preds) >= 4:
                days.append({"date": d, "obs": o, "preds": preds})
    return days


def fold(d: date) -> int:
    """Meses alternos: 0 o 1. Así cada mitad tiene días de todas las estaciones del año."""
    return (d.year * 12 + d.month) % 2


def model_skill(days: list[dict]) -> dict[str, float]:
    return {m: scores([(r["preds"][m], r["obs"], r["date"]) for r in days if m in r["preds"]])["heidke"] for m in MODELS}


def combine(days: list[dict], weights: dict[str, float] | None) -> list[tuple]:
    """Pares (previsto, medido, fecha) con la mediana normal (weights=None) o ponderada."""
    out = []
    for r in days:
        models = list(r["preds"])
        vals = [r["preds"][m] for m in models]
        value = statistics.median(vals) if weights is None else weighted_median(vals, [weights[m] for m in models])
        out.append((value, r["obs"], r["date"]))
    return out


def paired_difference(a: list[tuple], b: list[tuple]) -> tuple[float, float]:
    """Intervalo del 90 % de la diferencia de Heidke (a − b), remuestreando fechas.

    Se remuestrean los mismos días para los dos métodos: así la comparación es
    mucho más precisa que mirar si se solapan sus intervalos por separado.
    """
    by_date: dict[date, list[int]] = {}
    for i, (_, _, d) in enumerate(a):
        by_date.setdefault(d, []).append(i)
    dates = list(by_date)
    rng = random.Random(42)
    diffs = []
    for _ in range(BOOTSTRAP):
        idx = [i for d in rng.choices(dates, k=len(dates)) for i in by_date[d]]
        diffs.append(scores([a[i] for i in idx])["heidke"] - scores([b[i] for i in idx])["heidke"])
    diffs.sort()
    return diffs[int(0.05 * BOOTSTRAP)], diffs[int(0.95 * BOOTSTRAP) - 1]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    for lead in LEADS:
        days = build_days(lead)
        print(f"== Predicción hecha {lead} día(s) antes · {len(days)} días ==")

        # Validación cruzada: pesos aprendidos en una mitad, evaluados en la otra, y al revés.
        results: dict[str, list[tuple]] = {"Mediana normal": combine(days, None)}
        for k in POWERS:
            pairs = []
            for test in (0, 1):
                train_skill = model_skill([r for r in days if fold(r["date"]) != test])
                weights = {m: max(s, 0) ** k for m, s in train_skill.items()}
                pairs += combine([r for r in days if fold(r["date"]) == test], weights)
            pairs.sort(key=lambda p: p[2])
            results[f"Ponderada (Heidke^{k})"] = pairs
        results["Solo ECMWF"] = [(r["preds"]["ecmwf_ifs025"], r["obs"], r["date"]) for r in days if "ecmwf_ifs025" in r["preds"]]

        # Mismo orden de días en todos los métodos para poder compararlos día a día.
        base = sorted(results["Mediana normal"], key=lambda p: p[2])
        results["Mediana normal"] = base
        print(f"{'Método':24} {'Acierto':>8} {'Detecta':>8} {'F. alarma':>9} {'Heidke':>7} {'Error mm':>9}  Diferencia con la mediana (90 %)")
        for name, pairs in results.items():
            sc = scores(pairs)
            diff = ""
            if name != "Mediana normal" and len(pairs) == len(base):
                lo, hi = paired_difference(pairs, base)
                diff = f"{sc['heidke'] - scores(base)['heidke']:+.3f}  ({lo:+.3f} a {hi:+.3f})"
            print(f"{name:24} {sc['acierto']:7.1f}% {sc['deteccion']:7.1f}% {sc['falsas']:8.1f}% "
                  f"{sc['heidke']:7.3f} {sc['error_mm']:9.2f}  {diff}")

        # Pesos con todo el año (los que usaría la web si compensa).
        skill = model_skill(days)
        print("Pesos con todo el año (Heidke):", ", ".join(f"{MODELS[m]} {s:.2f}" for m, s in skill.items()))
        print()


if __name__ == "__main__":
    main()
