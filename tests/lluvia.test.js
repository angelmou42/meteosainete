// Tests de la lluvia por horas y la frase resumen (core.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, daySummary, formatPeriods, hourlyRain, rainPeriods, rainSlots } from "../core.js";

/* Día de prueba (día 0). `hours` da la lluvia de cada modelo por franjas:
 * { 15: 1.2 } = 1,2 mm entre las 15 y las 16 h. `models` dice cuántos de los 6
 * modelos llueven así (los demás, secos). La marca de la franja k es k + 1. */
function day({ hours = {}, models = 6, missing = [] }) {
  const m = {};
  MODELS.forEach((model, r) => {
    const hrain = Array(25).fill(0);
    if (r < models) for (const [k, v] of Object.entries(hours)) hrain[Number(k) + 1] = v;
    const total = hrain.reduce((a, b) => a + b, 0);
    const off = missing.includes(r);
    m[model.id] = { tmax: [off ? null : 20], tmin: [10], rain: [off ? null : total], prob: [null], wind: [10], hrain };
  });
  return { m };
}

const range = (from, to, v) => Object.fromEntries(Array.from({ length: to - from }, (_, i) => [from + i, v]));

test("hourlyRain: la franja de 15 a 16 h es la marca de las 16:00", () => {
  const rows = hourlyRain(day({ hours: { 15: 2 } }), 0);
  assert.equal(rows.length, MODELS.length);
  assert.equal(rows[0][15], 2);
  assert.equal(rows[0][14], 0);
});

test("rainSlots: llueve si lo dan más de la mitad de los modelos", () => {
  assert.equal(rainSlots(hourlyRain(day({ hours: { 15: 1 }, models: 4 }), 0))[15].rainy, true);
  assert.equal(rainSlots(hourlyRain(day({ hours: { 15: 1 }, models: 3 }), 0))[15].rainy, false); // empate
});

test("rainPeriods: tramos seguidos y huecos de una hora unidos", () => {
  const slots = (hours) => rainSlots(hourlyRain(day({ hours }), 0));
  assert.deepEqual(rainPeriods(slots(range(15, 19, 1))), [[15, 19]]);
  assert.deepEqual(rainPeriods(slots({ ...range(6, 9, 1), ...range(15, 19, 1) })), [[6, 9], [15, 19]]);
  assert.deepEqual(rainPeriods(slots({ ...range(15, 17, 1), ...range(18, 20, 1) })), [[15, 20]]); // hueco de 1 h
  assert.deepEqual(rainPeriods(slots(range(6, 9, 1)), 10), []); // desde las 10 ya no llueve
});

test("formatPeriods: frases largas y cortas", () => {
  assert.equal(formatPeriods([]), "");
  assert.equal(formatPeriods([[15, 19]]), "de 15 a 19 h");
  assert.equal(formatPeriods([[6, 9], [15, 19]]), "de 6 a 9 h y de 15 a 19 h");
  assert.equal(formatPeriods([[0, 24]]), "todo el día");
  assert.equal(formatPeriods([[15, 19]], true), "15–19 h");
  assert.equal(formatPeriods([[1, 2], [5, 6], [9, 10]], true), "a ratos");
});

test("daySummary: lluvia clara, seco y dudoso", () => {
  const rain = daySummary(day({ hours: range(15, 19, 1) }), 0);
  assert.equal(rain.tone, "rain");
  assert.equal(rain.text, "Lluvia débil de 15 a 19 h. Los 6 modelos dan lluvia.");

  const dry = daySummary(day({}), 0);
  assert.equal(dry.tone, "dry");
  assert.equal(dry.text, "Sin lluvia. Los 6 modelos están de acuerdo.");

  const doubt = daySummary(day({ hours: range(15, 19, 1), models: 2 }), 0);
  assert.equal(doubt.tone, "doubt");
  assert.match(doubt.text, /2 de 6 modelos/);
});

test("daySummary: hoy, la intensidad es la de la lluvia que queda", () => {
  // 10 mm de madrugada y 0,5 mm a las 22: desde las 20 h solo queda llovizna.
  const s = daySummary(day({ hours: { ...range(2, 7, 2), 22: 0.5 } }), 0, 20);
  assert.equal(s.text, "Llovizna de 22 a 23 h. Los 6 modelos dan lluvia.");
});

test("daySummary: lluvia repartida sin hora en común", () => {
  // 4 modelos dan lluvia, pero cada uno a una hora distinta: ninguna franja tiene mayoría.
  const data = day({});
  MODELS.slice(0, 4).forEach((m, r) => { data.m[m.id].hrain[r * 3 + 1] = 0.3; data.m[m.id].rain[0] = 0.3; });
  const s = daySummary(data, 0);
  assert.equal(s.tone, "doubt");
  assert.match(s.text, /sin hora clara: 4 de 6 modelos/);
});

test("daySummary: hoy, si la lluvia ya pasó, lo dice", () => {
  const s = daySummary(day({ hours: range(3, 6, 1) }), 0, 14);
  assert.equal(s.text, "No se espera más lluvia hoy.");
});

test("daySummary: el modelo sin datos ese día no cuenta", () => {
  const s = daySummary(day({ hours: range(15, 19, 1), models: 5, missing: [5] }), 0);
  assert.match(s.text, /Los 5 modelos dan lluvia/);
});
