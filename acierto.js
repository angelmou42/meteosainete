/* Meteosainete — pestaña "Acierto"
 *
 * Muestra cuánto acierta cada modelo con la lluvia. Los números salen de
 * analisis/resultados.json, que genera analisis/verificacion_lluvia.py: si se
 * repite el análisis, la web se actualiza sola sin tocar este archivo.
 *
 * app.js usa initAccuracy() y showAccuracy(); el resto se exporta para los tests.
 */
import { $, MODELS, fetchJson, fmt, state } from "./core.js";

const accuracy = {
  data: null,     // contenido de resultados.json
  loading: null,  // promesa de la descarga (para no pedirlo dos veces)
  lead: 1,        // días de antelación elegidos: 1 | 3
};

// Se llama al abrir la pestaña. Descarga los resultados la primera vez.
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
  }
  renderAccuracy();
}

function renderAccuracy() {
  const d = accuracy.data;
  const rows = d.resultados.filter((r) => r.antelacion === accuracy.lead);
  // De mejor a peor puntuación, con la referencia "siempre seco" siempre al final.
  rows.sort((a, b) => (a.id === "siempre_seco") - (b.id === "siempre_seco") || b.heidke - a.heidke);

  const date = (iso) => new Date(iso + "T12:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  $("acc-intro").textContent =
    `Lluvia prevista frente a la medida en las estaciones de ${listJoin(d.estaciones.map((e) => e.nombre))}, ` +
    `del ${date(d.periodo[0])} al ${date(d.periodo[1])}: ${fmt(d.dias)} días, ${fmt(d.dias_lluvia)} de ellos con lluvia ` +
    `(${fmt(d.umbral_mm)} mm o más).`;

  renderAreaWarning(d.estaciones);

  // Resumen calculado con los datos: mejor modelo suelto y comparación con el consenso.
  const models = rows.filter((r) => r.id !== "consenso" && r.id !== "siempre_seco");
  const best = models[0], worst = models[models.length - 1];
  const cons = rows.find((r) => r.id === "consenso");
  const dry = rows.find((r) => r.id === "siempre_seco");
  $("acc-summary").innerHTML =
    `<li>El <b>consenso</b> ${cons.heidke >= best.heidke ? "es lo que mejor funciona" : "queda cerca de lo mejor"}: ` +
    `puntuación ${fmt(cons.heidke, 2)} y solo un ${fmt(cons.falsas)} % de falsas alarmas.</li>` +
    `<li>El mejor modelo suelto es <b>${best.modelo}</b> (${fmt(best.heidke, 2)}); el que menos, <b>${worst.modelo}</b> (${fmt(worst.heidke, 2)}).</li>` +
    `<li>Decir siempre "seco" ya acierta el ${fmt(dry.acierto)} % de los días, porque llueve poco: ` +
    `por eso la columna que importa es la <b>puntuación</b>, no el acierto.</li>`;

  const swatch = (r) => {
    if (r.id === "consenso") return "var(--ink)";
    if (r.id === "siempre_seco") return "var(--line)";
    return `var(${MODELS.find((m) => m.id === r.id)?.c || "--muted"})`;
  };
  const pct = (v) => (v == null ? "—" : `${fmt(v)} %`);
  // Barra de puntuación (0–1) con una raya que marca el margen de error del 90 %.
  const bar = (r) => `
    <div class="score" title="Margen de error (90 %): ${fmt(r.heidke_min90, 2)} – ${fmt(r.heidke_max90, 2)}">
      <div class="score-track">
        <span class="score-fill" style="width:${Math.max(0, r.heidke) * 100}%"></span>
        <span class="score-range" style="left:${r.heidke_min90 * 100}%;width:${(r.heidke_max90 - r.heidke_min90) * 100}%"></span>
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
          ${r.dias < d.dias ? `<div class="morigin">${fmt(r.dias)} días con datos</div>` : ""}</th>
        <td class="col-score">${bar(r)}</td>
        <td>${pct(r.acierto)}</td>
        <td>${pct(r.deteccion)}</td>
        <td>${pct(r.falsas)}</td>
        <td>${fmt(r.error_mm, 1)} mm</td>
      </tr>`).join("")}
    </tbody>`;
}

/* El estudio solo vale para la zona de sus estaciones. Si la ciudad que se está
 * viendo queda lejos, se avisa: en otro clima el orden de los modelos puede cambiar. */
const NEAR_KM = 100;

function renderAreaWarning(stations) {
  const el = $("acc-area");
  const place = state.place;
  const km = place ? Math.min(...stations.map((e) => distanceKm(place.lat, place.lon, e.lat, e.lon))) : 0;
  el.classList.toggle("is-far", km > NEAR_KM);
  el.textContent = km > NEAR_KM
    ? `Ojo: estás viendo ${place.label}, a unos ${fmt(Math.round(km / 10) * 10)} km de la estación más cercana del estudio. ` +
      "Estos resultados son de Andalucía oriental; en otra zona el orden de los modelos puede ser distinto."
    : "Estos resultados son de Andalucía oriental, la zona de la ciudad que estás viendo.";
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

// Botones "1 día antes / 3 días antes". Se conectan una vez desde app.js.
export function initAccuracy() {
  $("acc-leads").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    accuracy.lead = Number(tab.dataset.lead);
    $("acc-leads").querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    if (accuracy.data) renderAccuracy();
  });
}
