// Tests de las funciones puras de la pestaña "Acierto" (acierto.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { distanceKm, listJoin } from "../acierto.js";

test("distanceKm: Jaén–Granada son unos 67 km y un punto consigo mismo, 0", () => {
  const km = distanceKm(37.7833, -3.8, 37.1833, -3.7833);
  assert.ok(km > 60 && km < 72, `salió ${km}`);
  assert.equal(distanceKm(40, -3, 40, -3), 0);
});

test("listJoin: enumera en español", () => {
  assert.equal(listJoin(["Jaén"]), "Jaén");
  assert.equal(listJoin(["Jaén", "Granada"]), "Jaén y Granada");
  assert.equal(listJoin(["Jaén", "Córdoba", "Granada"]), "Jaén, Córdoba y Granada");
});

test("resultados.json: tiene lo que necesita la pestaña", () => {
  const data = JSON.parse(readFileSync(new URL("../analisis/resultados.json", import.meta.url), "utf8"));
  assert.ok(data.estaciones.every((e) => typeof e.lat === "number" && typeof e.lon === "number"));
  for (const lead of [1, 3]) {
    const rows = data.resultados.filter((r) => r.antelacion === lead);
    assert.ok(rows.some((r) => r.id === "consenso"), `falta el consenso a ${lead} día(s)`);
    assert.ok(rows.some((r) => r.id === "siempre_seco"), `falta la referencia a ${lead} día(s)`);
    for (const r of rows) assert.ok(r.heidke_min90 <= r.heidke && r.heidke <= r.heidke_max90, `${r.modelo}: margen incoherente`);
  }
});
