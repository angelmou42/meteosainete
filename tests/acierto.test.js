// Tests de las funciones puras de la pestaña "Acierto" (acierto.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NEAR_KM, chanceOfRain, distanceKm, listJoin, pickRegion, sortRows } from "../acierto.js";

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

const REGIONS = [
  { id: "espana", estaciones: [] },
  { id: "andalucia_oriental", estaciones: [{ lat: 37.78, lon: -3.8 }] },
  { id: "galicia", estaciones: [{ lat: 43.37, lon: -8.42 }] },
];

test("pickRegion: la zona con la estación más cercana", () => {
  assert.equal(pickRegion(REGIONS, { lat: 37.93, lon: -4.05 }).region.id, "andalucia_oriental"); // Arjona
  assert.equal(pickRegion(REGIONS, { lat: 42.88, lon: -8.54 }).region.id, "galicia");            // Santiago
});

test("pickRegion: lejos de todas las estaciones, toda España", () => {
  const { region, km } = pickRegion(REGIONS, { lat: 48.85, lon: 2.35 }); // París
  assert.equal(region.id, "espana");
  assert.ok(km > NEAR_KM);
  assert.equal(pickRegion(REGIONS, null).region.id, "espana");
});

test("sortRows: de mejor a peor y la referencia al final", () => {
  const rows = [{ id: "siempre_seco", heidke: 0 }, { id: "a", heidke: 0.5 }, { id: "b", heidke: 0.8 }, { id: "c", heidke: null }];
  assert.deepEqual(sortRows(rows).map((r) => r.id), ["b", "a", "c", "siempre_seco"]);
});

test("chanceOfRain: busca por sextos y exige datos suficientes", () => {
  const table = [
    { antelacion: 1, modelos: 3, dias: 200, llovio_pct: 41 },
    { antelacion: 1, modelos: 6, dias: 10, llovio_pct: 90 },
    { antelacion: 3, modelos: 3, dias: 150, llovio_pct: 35 },
  ];
  assert.equal(chanceOfRain(table, 1, 3, 6), 41);
  assert.equal(chanceOfRain(table, 3, 3, 6), 35);
  assert.equal(chanceOfRain(table, 1, 2, 4), 41);   // 2 de 4 = 3 de 6
  assert.equal(chanceOfRain(table, 1, 6, 6), null); // solo 10 días: no basta
  assert.equal(chanceOfRain(null, 1, 3, 6), null);
});

test("resultados.json: cada zona tiene lo que necesita la pestaña", () => {
  const data = JSON.parse(readFileSync(new URL("../analisis/resultados.json", import.meta.url), "utf8"));
  assert.equal(data.regiones[0].id, "espana");
  for (const region of data.regiones) {
    assert.ok(region.estaciones.every((e) => typeof e.lat === "number" && typeof e.lon === "number"), region.id);
    for (const lead of [1, 3]) {
      const rows = region.resultados.filter((r) => r.antelacion === lead);
      assert.ok(rows.some((r) => r.id === "consenso"), `${region.id}: falta el consenso a ${lead} día(s)`);
      assert.ok(rows.some((r) => r.id === "siempre_seco"), `${region.id}: falta la referencia a ${lead} día(s)`);
      assert.ok(region.lo_dan.some((r) => r.antelacion === lead), `${region.id}: falta la tabla «lo dan» a ${lead} día(s)`);
      for (const r of rows) {
        if (r.heidke == null || r.heidke_min90 == null) continue;
        assert.ok(r.heidke_min90 <= r.heidke && r.heidke <= r.heidke_max90, `${region.id} · ${r.modelo}: margen incoherente`);
      }
    }
  }
});
