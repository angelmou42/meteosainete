// Tests de las listas de ciudades recientes y favoritas (places.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeLabel, pushRecent, samePlace, toggleFavorite } from "../places.js";

const arjona = { lat: 37.935, lon: -4.055, label: "Arjona" };
const jaen = { lat: 37.78, lon: -3.79, label: "Jaén" };
const granada = { lat: 37.19, lon: -3.61, label: "Granada" };

test("samePlace: a menos de ~1 km es el mismo sitio", () => {
  assert.equal(samePlace(arjona, { lat: 37.9351, lon: -4.0549 }), true);
  assert.equal(samePlace(arjona, jaen), false);
});

test("pushRecent: la última va primera, sin repetir y con máximo", () => {
  let list = pushRecent([], arjona);
  list = pushRecent(list, jaen);
  list = pushRecent(list, arjona);
  assert.deepEqual(list.map((p) => p.label), ["Arjona", "Jaén"]);
  assert.equal(pushRecent([jaen, granada], arjona, 2).length, 2);
});

test("toggleFavorite: añade y quita", () => {
  const on = toggleFavorite([], granada);
  assert.deepEqual(on, [granada]);
  assert.deepEqual(toggleFavorite(on, { ...granada, label: "otra etiqueta" }), []);
});

test("placeLabel: nombre, región y país sin huecos", () => {
  assert.equal(placeLabel({ name: "Arjona", admin1: "Andalucía", country: "España" }), "Arjona, Andalucía, España");
  assert.equal(placeLabel({ name: "Mónaco", country: "Mónaco" }), "Mónaco, Mónaco");
});
