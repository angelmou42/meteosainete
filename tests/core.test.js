// Tests de core.js: utilidades y cálculo del consenso.
// Ejecutar con:  npm test   (o  node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, consensus, dayAlerts, dayName, dropPastDays, ensembleProb, estimateProb, fmt, median, publishesProb, rainLabel } from "../core.js";

test("median: impar, par, con huecos y vacía", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, 5, NaN, 1]), 3);
  assert.equal(median([null, null]), null);
});

test("fmt: coma decimal y guion si no hay dato", () => {
  assert.equal(fmt(1.5, 1), "1,5");
  assert.equal(fmt(2.345, 2), "2,35");
  assert.equal(fmt(7), "7");
  assert.equal(fmt(null), "—");
});

test("rainLabel: cada umbral cae en su categoría", () => {
  assert.equal(rainLabel(0), "seco");
  assert.equal(rainLabel(0.09), "seco");
  assert.equal(rainLabel(0.1), "llovizna");
  assert.equal(rainLabel(1), "débil");
  assert.equal(rainLabel(5), "moderada");
  assert.equal(rainLabel(15), "fuerte");
  assert.equal(rainLabel(30), "muy fuerte");
  assert.equal(rainLabel(null), "");
});

test("estimateProb: sube con los mm y no inventa sin dato", () => {
  assert.equal(estimateProb(0), 0);
  assert.equal(estimateProb(0.5), 30);
  assert.equal(estimateProb(20), 90);
  assert.equal(estimateProb(null), null);
});

test("dayName: hoy, mañana y día de la semana", () => {
  assert.equal(dayName("2026-10-29", 0), "Hoy");
  assert.equal(dayName("2026-10-30", 1), "Mañana");
  assert.equal(dayName("2026-10-31", 2), "sáb 31");
});

/* Datos de prueba para un solo día: un valor por modelo (en el orden de MODELS).
 * Un null en tmax significa que ese modelo no llega a ese día. */
function oneDay({ tmax, rain, prob = [] }) {
  const m = {};
  MODELS.forEach((model, k) => {
    m[model.id] = { tmax: [tmax[k]], tmin: [5], rain: [rain[k]], prob: [prob[k] ?? null], wind: [10] };
  });
  return { m };
}

test("consensus: todos de acuerdo → fiabilidad alta", () => {
  const c = consensus(oneDay({ tmax: [20, 21, 20, 22, 21, 20], rain: [0, 0, 0, 0, 0, 0] }), 0);
  assert.equal(c.level, "alta");
  assert.equal(c.tmax, 20.5);
  assert.equal(c.wet, 0);
  assert.equal(c.n, 6);
});

test("consensus: máximas separadas 3 °C → fiabilidad media", () => {
  const c = consensus(oneDay({ tmax: [18, 19, 20, 21, 20, 19], rain: [0, 0, 0, 0, 0, 0] }), 0);
  assert.equal(c.spread, 3);
  assert.equal(c.level, "media");
});

test("consensus: solo un modelo da lluvia → media; la mitad → baja", () => {
  const one = consensus(oneDay({ tmax: [20, 20, 20, 20, 20, 20], rain: [3, 0, 0, 0, 0, 0] }), 0);
  assert.equal(one.wet, 1);
  assert.equal(one.level, "media");
  const half = consensus(oneDay({ tmax: [20, 20, 20, 20, 20, 20], rain: [3, 2, 4, 0, 0, 0] }), 0);
  assert.equal(half.level, "baja");
});

test("consensus: el modelo sin datos ese día no cuenta", () => {
  const c = consensus(oneDay({ tmax: [20, 20, 20, null, 20, 20], rain: [0, 0, 0, 50, 0, 0] }), 0);
  assert.equal(c.n, 5);
  assert.equal(c.wet, 0);
  assert.equal(c.rain, 0);
});

test("consensus: con pocos modelos la fiabilidad baja aunque coincidan", () => {
  const two = consensus(oneDay({ tmax: [20, 20, null, null, null, null], rain: [0, 0, 0, 0, 0, 0] }), 0);
  assert.equal(two.n, 2);
  assert.equal(two.level, "baja");
  const three = consensus(oneDay({ tmax: [20, 20, null, null, null, 20], rain: [0, 0, 0, 0, 0, 0] }), 0);
  assert.equal(three.level, "media");
  const five = consensus(oneDay({ tmax: [20, 20, 20, null, 20, 20], rain: [0, 0, 0, 0, 0, 0] }), 0);
  assert.equal(five.level, "alta");
});

test("consensus: la probabilidad es la mediana de las publicadas", () => {
  const c = consensus(oneDay({ tmax: [20, 20, 20, 20, 20, 20], rain: [0, 0, 0, 0, 0, 0], prob: [10, 20, 30, null, 40, 50] }), 0);
  assert.equal(c.prob, 30);
});

test("publishesProb: distingue modelos sin probabilidad", () => {
  assert.equal(publishesProb({ prob: [null, null] }), false);
  assert.equal(publishesProb({ prob: [null, 0] }), true);
});

test("dayAlerts: heladas, calor, viento y lluvia fuerte según el consenso", () => {
  const ids = (c) => dayAlerts({ tmax: 20, tmin: 8, wind: 15, rain: 0, ...c }).map((a) => a.id);
  assert.deepEqual(ids({}), []);
  assert.deepEqual(ids({ tmin: -1 }), ["helada"]);
  assert.deepEqual(ids({ tmax: 38, wind: 55 }), ["calor", "viento"]);
  assert.deepEqual(ids({ rain: 25 }), ["lluvia"]);
  assert.deepEqual(ids({ tmin: null }), []); // sin dato, sin aviso
});

test("dropPastDays: quita días pasados de los datos diarios y horarios", () => {
  const data = {
    dates: ["2026-10-29", "2026-10-30", "2026-10-31"],
    sun: { rise: ["a", "b", "c"], set: ["x", "y", "z"] },
    m: { ecmwf_ifs025: { tmax: [1, 2, 3], hourly: Array.from({ length: 72 }, (_, h) => h) } },
  };
  const out = dropPastDays(data, 1);
  assert.deepEqual(out.dates, ["2026-10-30", "2026-10-31"]);
  assert.deepEqual(out.m.ecmwf_ifs025.tmax, [2, 3]);
  assert.equal(out.m.ecmwf_ifs025.hourly[0], 24);
  assert.deepEqual(out.sun.rise, ["b", "c"]);
  assert.equal(dropPastDays(data, 0), data);
  assert.equal(data.dates.length, 3); // no modifica el original
});

test("ensembleProb: % de escenarios con 1 mm o más, alineado con las fechas", () => {
  const daily = {
    time: ["2026-10-30", "2026-10-31"],
    precipitation_sum: [0, 5],
    ...Object.fromEntries(Array.from({ length: 19 }, (_, k) => [`precipitation_sum_member${String(k + 1).padStart(2, "0")}`, [k < 5 ? 2 : 0, null]])),
  };
  // Día 1: 5 de 20 escenarios con ≥ 1 mm → 25 %. Día 2: solo 1 valor → null. Fecha que no viene → null.
  assert.deepEqual(ensembleProb(daily, ["2026-10-30", "2026-10-31", "2026-11-01"]), [25, null, null]);
});
