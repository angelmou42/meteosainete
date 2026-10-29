/* Meteosainete — pestaña "Acierto"
 *
 * Muestra cuánto acierta cada modelo con la lluvia en la zona de España más
 * cercana a la ciudad que se está viendo (o en la que se elija). Los números
 * salen de analisis/resultados.json, que genera analisis/verificacion_lluvia.py:
 * si se repite el análisis, la web se actualiza sola sin tocar este archivo.
 *
 * app.js usa initAccuracy() y showAccuracy(); el resto se exporta para los tests.
 */
import { $, MODELS, fetchJson, fmt, state } from "./core.js";

// Más allá de esta distancia a la estación más cercana, no se asigna zona: se usa toda España.
export const NEAR_KM = 150;

const accuracy = {
  data: null,     // contenido de resultados.json
  loading: null,  // promesa de la descarga (para no pedirlo dos veces)
  lead: 1,        // días de antelación elegidos: 1 | 3
  zone: "auto",   // zona elegida en el desplegable: "auto" = la más cercana a la ciudad
};

// Se llama al abrir la pestaña y al cambiar de ciudad. Descarga los resultados la primera vez.
export async function showAccuracy() {
  if (!accuracy.data) {
    $("acc-status").hidden = false;
    $("acc-status").textContent = "Cargando resultados…";
    try {
      accuracy.loading ??= fetchJson("analisis/resultados.json");
      accuracy.data = await accuracy.loading;
    } catch (err) {
      accuracy.loading = null; // permite reintentar al volver a abrir la pestaña
      $("acc-status").textContent = "No se han podido cargar los resultados del análisis. Recarga la página para intentarlo de nuevo.";
      return;
    }
    $("acc-status").hidden = true;
    renderZoneSelect();
  }
  renderAccuracy();
}

/* Zona del estudio que corresponde a un sitio: la que tiene la estación más
 * cercana, si está a menos de NEAR_KM; si no, toda España.
 * Devuelve { region, km } (km = distancia a la estación más cercana). */
export function pickRegion(regions, place) {
  const all = regions.find((r) => r.id === "espana");
  if (!place) return { region: all, km: null };
  let best = null, bestKm = Infinity;
  for (const r of regions) {
    if (r.id === "espana") continue;
    for (const e of r.estaciones) {
      const km = distanceKm(place.lat, place.lon, e.lat, e.lon);
      if (km < bestKm) { bestKm = km; best = r; }
    }
  }
  return { region: bestKm <= NEAR_KM ? best : all, km: bestKm };
}

function renderZoneSelect() {
  const sel = $("acc-zone");
  sel.innerHTML = `<option value="auto">La más cercana</option>` +
    accuracy.data.regiones.map((r) => `<option value="${r.id}">${r.nombre}</option>`).join("");
  sel.value = accuracy.zone;
}

// Mejor primero, con la referencia "siempre seco" siempre al final.
export function sortRows(rows) {
  return [...rows].sort((a, b) => (a.id === "siempre_seco") - (b.id === "siempre_seco") || (b.heidke ?? -1) - (a.heidke ?? -1));
}

function renderAccuracy() {
  const d = accuracy.data;
  const auto = pickRegion(d.regiones, state.place);
  const region = accuracy.zone === "auto" ? auto.region : d.regiones.find((r) => r.id === accuracy.zone);
  const rows = sortRows(region.resultados.filter((r) => r.antelacion === accuracy.lead));

  const date = (iso) => new Date(iso + "T12:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  const where = region.id === "espana"
    ? `${region.estaciones.length} estaciones de AEMET repartidas por toda España`
    : `las estaciones de ${listJoin(region.estaciones.map((e) => e.nombre))}`;
  $("acc-intro").textContent =
    `Lluvia prevista frente a la medida en ${where}, del ${date(d.periodo[0])} al ${date(d.periodo[1])}: ` +
    `${fmt(region.dias)} días, ${fmt(region.dias_lluvia)} de ellos con lluvia (${fmt(d.umbral_mm)} mm o más).`;

  renderAreaNote(region, auto);

  // Resumen calculado con los datos: mejor modelo suelto, consenso y referencia.
  const models = rows.filter((r) => r.id !== "consenso" && r.id !== "siempre_seco" && r.heidke != null);
  const best = models[0], worst = models[models.length - 1];
  const cons = rows.find((r) => r.id === "consenso");
  const dry = rows.find((r) => r.id === "siempre_seco");
  const spainBest = region.id === "espana" ? null
    : sortRows(d.regiones.find((r) => r.id === "espana").resultados.filter((r) => r.antelacion === accuracy.lead))
      .find((r) => r.id !== "consenso" && r.id !== "siempre_seco");
  $("acc-summary").innerHTML =
    `<li>El <b>consenso</b> ${cons.heidke >= best.heidke ? "es lo que mejor funciona" : "queda cerca de lo mejor"}: ` +
    `puntuación ${fmt(cons.heidke, 2)} y un ${fmt(cons.falsas)} % de falsas alarmas.</li>` +
    `<li>El mejor modelo suelto aquí es <b>${best.modelo}</b> (${fmt(best.heidke, 2)}); el que menos, <b>${worst.modelo}</b> (${fmt(worst.heidke, 2)})` +
    `${spainBest && spainBest.id !== best.id ? `. En el conjunto de España el mejor es ${spainBest.modelo}` : ""}.</li>` +
    `<li>Decir siempre "seco" ya acierta el ${fmt(dry.acierto)} % de los días: ` +
    `por eso la columna que importa es la <b>puntuación</b>, no el acierto.</li>`;

  const swatch = (r) => {
    if (r.id === "consenso") return "var(--ink)";
    if (r.id === "siempre_seco") return "var(--line)";
    return `var(${MODELS.find((m) => m.id === r.id)?.c || "--muted"})`;
  };
  const pct = (v) => (v == null ? "—" : `${fmt(v)} %`);
  // Barra de puntuación (0–1) con una raya que marca el margen de error del 90 %.
  const bar = (r) => r.heidke == null ? "—" : `
    <div class="score" title="Margen de error (90 %): ${fmt(r.heidke_min90, 2)} – ${fmt(r.heidke_max90, 2)}">
      <div class="score-track">
        <span class="score-fill" style="width:${Math.max(0, r.heidke) * 100}%"></span>
        ${r.heidke_min90 == null ? "" : `<span class="score-range" style="left:${Math.max(0, r.heidke_min90) * 100}%;width:${(r.heidke_max90 - Math.max(0, r.heidke_min90)) * 100}%"></span>`}
      </div>
      <span class="score-val">${fmt(r.heidke, 2)}</span>
    </div>`;

  $("acc-table").innerHTML = `
    <thead><tr>
      <th>Modelo</th><th class="col-score">Puntuación</th><th>Acierto</th>
      <th>Detecta la lluvia</th><th>Falsas alarmas</th><th>Error medio</th>
    </tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="${r.id === "consenso" ? "cons" : r.id === "siempre_seco" ? "ref" : ""}">
        <th><div class="mname"><i style="background:${swatch(r)}"></i>${r.modelo}</div>
          ${r.dias < region.dias ? `<div class="morigin">${fmt(r.dias)} días con datos</div>` : ""}</th>
        <td class="col-score">${bar(r)}</td>
        <td>${pct(r.acierto)}</td>
        <td>${pct(r.deteccion)}</td>
        <td>${pct(r.falsas)}</td>
        <td>${fmt(r.error_mm, 1)} mm</td>
      </tr>`).join("")}
    </tbody>`;
}

// Explica de qué zona son los resultados y por qué, según la ciudad que se está viendo.
function renderAreaNote(region, auto) {
  const el = $("acc-area");
  const place = state.place;
  const far = auto.region.id === "espana" && auto.km != null;
  el.classList.toggle("is-far", accuracy.zone === "auto" && far);
  if (accuracy.zone !== "auto") {
    el.textContent = `Zona: ${region.nombre} (elegida a mano).`;
  } else if (!place) {
    el.textContent = `Zona: ${region.nombre}.`;
  } else if (far) {
    el.textContent = `${place.label} queda a unos ${fmt(Math.round(auto.km / 10) * 10)} km de la estación más cercana del estudio, ` +
      "así que se muestran los resultados de toda España. Puedes elegir otra zona en el desplegable.";
  } else {
    el.textContent = `Zona: ${region.nombre}, la del estudio más cercana a ${place.label.split(",")[0]}.`;
  }
}

// Distancia en km entre dos puntos (fórmula del haversine).
export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// "Jaén, Córdoba y Granada"
export function listJoin(items) {
  return items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " y " + items[items.length - 1];
}

// Botones "1 día / 3 días" y desplegable de zona. Se conectan una vez desde app.js.
export function initAccuracy() {
  $("acc-leads").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    accuracy.lead = Number(tab.dataset.lead);
    $("acc-leads").querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    if (accuracy.data) renderAccuracy();
  });
  $("acc-zone").addEventListener("change", (e) => {
    accuracy.zone = e.target.value;
    if (accuracy.data) renderAccuracy();
  });
}
