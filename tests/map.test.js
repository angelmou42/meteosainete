// Tests de las funciones puras del mapa de lluvia (map.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bilinear, currentIndex, gridBounds, hourRange, rainColor } from "../map.js";

test("bilinear: devuelve las esquinas y la media en el centro", () => {
  // Esquinas: a (suroeste), b (sureste), d (noroeste), e (noreste).
  assert.equal(bilinear(1, 2, 3, 4, 0, 0), 1);
  assert.equal(bilinear(1, 2, 3, 4, 1, 0), 2);
  assert.equal(bilinear(1, 2, 3, 4, 0, 1), 3);
  assert.equal(bilinear(1, 2, 3, 4, 1, 1), 4);
  assert.equal(bilinear(1, 2, 3, 4, 0.5, 0.5), 2.5);
});

test("rainColor: transparente por debajo de 0,1 mm y el color más fuerte arriba", () => {
  assert.equal(rainColor(0), null);
  assert.equal(rainColor(0.05), null);
  assert.ok(rainColor(0.1));
  assert.deepEqual(rainColor(50), rainColor(30));
  assert.notDeepEqual(rainColor(0.1), rainColor(30));
});

test("hourRange: la lluvia de cada hora es la de la hora anterior", () => {
  assert.equal(hourRange(14), "13:00–14:00");
  assert.equal(hourRange(24), "23:00–00:00"); // medianoche del día siguiente
});

test("gridBounds: la rejilla queda centrada en la ciudad", () => {
  const place = { lat: 37.93, lon: -4.05 };
  const [[south, west], [north, east]] = gridBounds(place).bounds;
  assert.ok(Math.abs((south + north) / 2 - place.lat) < 1e-9);
  assert.ok(Math.abs((west + east) / 2 - place.lon) < 1e-9);
  assert.ok(east - west > north - south); // más ancha que alta, como la pantalla
});

test("currentIndex: elige la hora en curso en la zona horaria de la ciudad", (t) => {
  // 29/10/2026 a las 13:30 UTC = 14:30 en Madrid (UTC+1): la hora en curso es 14–15 h, marca "15:00".
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 29, 13, 30) });
  const times = Array.from({ length: 48 }, (_, h) => `2026-10-${29 + Math.floor(h / 24)}T${String(h % 24).padStart(2, "0")}:00`);
  assert.equal(times[currentIndex({ times, offset: 3600 })], "2026-10-29T15:00");
});
