// Tests del icono del tiempo, la noche y la temperatura actual (core.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, isNight, skyIcon, tempAt } from "../core.js";
import { ICON_LABELS, iconSvg } from "../icons.js";

/* Día de prueba: todos los modelos con la misma nubosidad, códigos y lluvia,
 * salvo que se indique otra cosa para los `others` últimos modelos. */
function day({ cloud = 0, code = 0, rainHours = {}, others = 0, otherCloud = cloud, otherCode = code }) {
  const m = {};
  MODELS.forEach((model, r) => {
    const isOther = r >= MODELS.length - others;
    const hrain = Array(25).fill(0);
    if (!isOther) for (const [k, v] of Object.entries(rainHours)) hrain[Number(k) + 1] = v;
    m[model.id] = {
      tmax: [20], tmin: [10], rain: [hrain.reduce((a, b) => a + b, 0)], prob: [null], wind: [10],
      hourly: Array.from({ length: 24 }, (_, h) => 10 + h / 2 + r),
      hrain,
      hcloud: Array(24).fill(isOther ? otherCloud : cloud),
      hcode: Array(24).fill(isOther ? otherCode : code),
    };
  });
  return { m, sun: { rise: ["2026-10-30T07:40"], set: ["2026-10-30T18:20"] } };
}

test("skyIcon: despejado, poco nuboso y nublado según la nubosidad", () => {
  assert.equal(skyIcon(day({ cloud: 10 }), 0), "clear");
  assert.equal(skyIcon(day({ cloud: 50 }), 0), "partly");
  assert.equal(skyIcon(day({ cloud: 90 }), 0), "cloudy");
  assert.equal(skyIcon(day({ cloud: 10 }), 0, { night: true }), "clear-night");
});

test("skyIcon: lluvia y llovizna según los mm de la mayoría", () => {
  assert.equal(skyIcon(day({ cloud: 90, rainHours: { 10: 2, 11: 2 } }), 0), "rain");
  assert.equal(skyIcon(day({ cloud: 90, rainHours: { 10: 0.3 } }), 0), "drizzle");
  // Solo 2 de 6 modelos dan lluvia: no es mayoría, manda la nubosidad.
  assert.equal(skyIcon(day({ cloud: 90, rainHours: { 10: 2 }, others: 4 }), 0), "cloudy");
});

test("skyIcon: tormenta y nieve solo si la mayoría lo dice", () => {
  assert.equal(skyIcon(day({ cloud: 90, code: 95, rainHours: { 10: 5 } }), 0), "storm");
  assert.equal(skyIcon(day({ cloud: 90, code: 73, rainHours: { 10: 2 } }), 0), "snow");
  assert.equal(skyIcon(day({ cloud: 90, code: 61, rainHours: { 10: 2 }, others: 2, otherCode: 95 }), 0), "rain");
});

test("skyIcon: niebla si la mayoría de los modelos la dan buena parte del día", () => {
  assert.equal(skyIcon(day({ cloud: 100, code: 45 }), 0), "fog");
});

test("isNight: antes de amanecer y después de anochecer", () => {
  const d = day({});
  assert.equal(isNight(d, 0, 3), true);
  assert.equal(isNight(d, 0, 12), false);
  assert.equal(isNight(d, 0, 19), true);
});

test("tempAt: mediana de los modelos a esa hora", () => {
  // A las 4 h cada modelo da 12 + r (r = 0…5): mediana 14,5.
  assert.equal(tempAt(day({}), 0, 4), 14.5);
});

test("iconSvg: cada icono tiene su texto para lectores de pantalla", () => {
  for (const key of Object.keys(ICON_LABELS)) assert.match(iconSvg(key), new RegExp(`aria-label="${ICON_LABELS[key]}"`));
});
