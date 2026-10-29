/* Meteosainete — módulo principal
 *
 * Flujo: load() pide la predicción de 6 modelos a Open-Meteo → normaliza los
 * datos en `state.data` → render() pinta la franja de consenso, la matriz
 * y el gráfico horario. Las utilidades y el cálculo del consenso están en
 * core.js; los mapas de lluvia en map.js y la pestaña de acierto en acierto.js.
 */
import { $, MODELS, consensus, dayName, estimateProb, fetchJson, fmt, isNum, median, nums, publishesProb, rainLabel, state } from "./core.js";
import { initMaps, updateMaps } from "./map.js";
import { initAccuracy, showAccuracy } from "./acierto.js";

/* ---------- Configuración ---------- */

const DEFAULT_PLACE = { lat: 37.93493, lon: -4.05478, label: "Arjona, Jaén, Andalucía, España" };

const STORAGE_KEY = "meteosainete:lastPlace";

/* ---------- Colores de las celdas ---------- */

// Fondo de cada celda según el valor.
function tempBg(t) {
  if (!isNum(t)) return "transparent";
  const hue = Math.max(0, Math.min(230, 230 - (t + 2) * 6.8)); // azul (frío) → rojo (calor)
  return `hsl(${hue} 78% 52% / .26)`;
}
function rainBg(mm) {
  if (!isNum(mm) || mm < 0.1) return "transparent";
  return `hsl(208 80% 50% / ${Math.min(0.65, 0.12 + mm / 18)})`;
}
function windBg(w) {
  if (!isNum(w)) return "transparent";
  return `hsl(170 45% 45% / ${Math.min(0.55, w / 90)})`;
}

/* ---------- localStorage (última ciudad) ----------
 * Envuelto en try/catch: en modo privado o con cookies bloqueadas
 * localStorage puede lanzar una excepción, y la web debe seguir funcionando. */

function savePlace(place) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(place)); } catch { /* sin almacenamiento: no pasa nada */ }
}

function readSavedPlace() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (p && isNum(p.lat) && isNum(p.lon) && typeof p.label === "string") return p;
  } catch { /* dato corrupto o almacenamiento bloqueado */ }
  return null;
}

/* ---------- Ciudad en la URL ----------
 * ?lugar=Arjona…&lat=37.93&lon=-4.05 permite compartir el enlace de un sitio
 * concreto. Se usa replaceState para no llenar el historial con cada búsqueda. */

function placeFromUrl() {
  const q = new URLSearchParams(location.search);
  const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
  if (!q.has("lat") || !q.has("lon") || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, label: q.get("lugar") || `${fmt(lat, 2)}, ${fmt(lon, 2)}` };
}

function placeToUrl(place) {
  const q = new URLSearchParams({ lugar: place.label, lat: place.lat, lon: place.lon });
  history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
}

/* ---------- Datos ---------- */

/* Pide todos los modelos en una sola llamada. Con varios modelos, Open-Meteo
 * devuelve cada variable con sufijo: temperature_2m_max_ecmwf_ifs025, etc.
 * Aquí lo reorganizamos por modelo para que el resto del código sea simple:
 *   { dates, m: { ecmwf_ifs025: { tmax, tmin, rain, prob, wind, hourly }, ... } }
 * Los días fuera del alcance de un modelo llegan como null. */
async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: "auto",
    forecast_days: 7,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    hourly: "temperature_2m",
    models: MODELS.map((m) => m.id).join(","),
  });
  const j = await fetchJson("https://api.open-meteo.com/v1/forecast?" + params);
  if (!j.daily || !j.hourly) throw new Error("Respuesta inesperada de la API");

  const days = j.daily.time.length;
  // Si una variable no viene, la rellenamos con null para no romper el render.
  const pick = (block, name, len, id) => j[block][`${name}_${id}`] || Array(len).fill(null);

  const out = { dates: j.daily.time, m: {} };
  for (const { id } of MODELS) {
    const hours = j.hourly.time.length;
    out.m[id] = {
      tmax: pick("daily", "temperature_2m_max", days, id),
      tmin: pick("daily", "temperature_2m_min", days, id),
      rain: pick("daily", "precipitation_sum", days, id),
      prob: pick("daily", "precipitation_probability_max", days, id),
      wind: pick("daily", "wind_speed_10m_max", days, id),
      hourly: pick("hourly", "temperature_2m", hours, id),
    };
  }
  return out;
}

/* ---------- Render ---------- */

function renderStrip() {
  const el = $("strip");
  el.innerHTML = "";
  state.data.dates.forEach((iso, i) => {
    const c = consensus(state.data, i);
    const probTxt = isNum(c.prob) ? `<b class="pct">${fmt(c.prob)} %</b> de lluvia · ` : "";
    const rainTxt = c.rain >= 0.1 ? `${fmt(c.rain, 1)} mm, ${rainLabel(c.rain)}` : "sin lluvia";

    const b = document.createElement("button");
    b.type = "button";
    b.className = "day";
    b.setAttribute("aria-pressed", String(i === state.sel));
    b.innerHTML = `
      <span class="dname">${dayName(iso, i)}</span>
      <span class="temps">${fmt(c.tmax)}°<small> / ${fmt(c.tmin)}°</small></span>
      <span class="rain">${probTxt}${rainTxt}<br>Lo dan ${c.wet} de ${c.n} modelos</span>
      <span class="chip c-${c.level}">Fiabilidad ${c.level}</span>`;
    b.addEventListener("click", () => { state.sel = i; render(); });
    el.appendChild(b);
  });
  $("strip-title").textContent = `Consenso de ${MODELS.length} modelos`;
}

// Texto de probabilidad para una celda de la pestaña Lluvia.
function probHtml(o, i) {
  if (isNum(o.prob[i])) return `<span class="pct">${fmt(o.prob[i])} %</span>`;
  if (o.estimable) {
    const est = estimateProb(o.rain[i]);
    return `<span class="pct est" title="Estimación a partir de los mm: este modelo no publica probabilidad">≈ ${fmt(est)} %</span>`;
  }
  return `<span class="pct na">— %</span>`;
}

// Una celda de la matriz según la pestaña activa. `o` es un modelo o la fila de consenso.
function cell(o, i) {
  if (!isNum(o.tmax[i])) return `<td class="na" title="Sin datos para este día">—</td>`;
  switch (state.view) {
    case "temp":
      return `<td style="background:${tempBg(o.tmax[i])}">${fmt(o.tmax[i])}°<span class="na"> / ${fmt(o.tmin[i])}°</span></td>`;
    case "rain": {
      const r = o.rain[i];
      return `<td style="background:${rainBg(r)}">${probHtml(o, i)}<span class="rmm">${fmt(r, r >= 0.1 ? 1 : 0)} mm</span><span class="rlab">${rainLabel(r)}</span></td>`;
    }
    default:
      return `<td style="background:${windBg(o.wind[i])}">${fmt(o.wind[i])}</td>`;
  }
}

function renderMatrix() {
  const d = state.data;
  const unit = { temp: "°C máx / mín", rain: "Prob. · total del día", wind: "km/h viento máx" }[state.view];
  let estimated = false;

  let html = `<thead><tr><th>${unit}</th>${d.dates.map((iso, i) => `<th>${dayName(iso, i)}</th>`).join("")}</tr></thead><tbody>`;
  for (const m of MODELS) {
    // Solo se estima la probabilidad si el modelo no la publica en ningún día.
    const o = { ...d.m[m.id], estimable: !publishesProb(d.m[m.id]) };
    if (o.estimable && o.rain.some(isNum)) estimated = true;
    html += `<tr><th><div class="mname"><i style="background:var(${m.c})"></i>${m.name}</div><div class="morigin">${m.origin}</div></th>${d.dates.map((_, i) => cell(o, i)).join("")}</tr>`;
  }

  // Fila de consenso: misma forma que un modelo para reutilizar cell().
  const cons = { tmax: [], tmin: [], rain: [], prob: [], wind: [], estimable: false };
  d.dates.forEach((_, i) => {
    const c = consensus(state.data, i);
    for (const k of ["tmax", "tmin", "rain", "prob", "wind"]) cons[k].push(c[k]);
  });
  html += `<tr class="cons"><th>Consenso</th>${d.dates.map((_, i) => cell(cons, i)).join("")}</tr></tbody>`;

  $("matrix").innerHTML = html;
  // Resalta la columna del día seleccionado.
  $("matrix").querySelectorAll("tbody tr").forEach((tr) => tr.children[state.sel + 1]?.classList.add("sel"));
  $("matrix-note").hidden = !(state.view === "rain" && estimated);
}

// Convierte puntos en un trazado SVG, cortando la línea donde falten datos.
function linePath(points) {
  let d = "", pen = false;
  for (const p of points) {
    if (!p) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

function renderChart() {
  const svg = $("chart");
  const d = state.data;
  const i = state.sel;
  const W = 720, H = 260, L = 36, R = 12, T = 14, B = 28; // tamaño y márgenes

  $("chart-title").textContent = "Temperatura hora a hora · " + dayName(d.dates[i], i).toLowerCase();
  $("legend").innerHTML = MODELS.map((m) => `<span><i style="background:var(${m.c})"></i>${m.name}</span>`).join("")
    + `<span><i style="background:var(--ink)"></i>Mediana</span>`;

  // 24 valores horarios del día seleccionado para cada modelo.
  const series = MODELS.map((m) => ({ m, v: d.m[m.id].hourly.slice(i * 24, i * 24 + 24) }));
  const all = series.flatMap((s) => nums(s.v));
  if (!all.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Sin datos horarios para este día</text>`;
    return;
  }

  // Escala vertical redondeada a múltiplos de 2 °C, con un mínimo de 6 °C de alto.
  let lo = Math.floor(Math.min(...all) / 2) * 2;
  let hi = Math.ceil(Math.max(...all) / 2) * 2;
  if (hi - lo < 6) { hi += 2; lo -= 2; }
  const x = (h) => L + (h * (W - L - R)) / 23;
  const y = (t) => T + ((hi - t) * (H - T - B)) / (hi - lo);

  let g = "";
  for (let t = lo; t <= hi; t += 2) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/>`;
    g += `<text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}°</text>`;
  }
  for (let h = 0; h < 24; h += 3) {
    g += `<text x="${x(h)}" y="${H - 8}" text-anchor="middle">${String(h).padStart(2, "0")}h</text>`;
  }

  // Banda gris (mínimo-máximo entre modelos) y mediana, hora a hora.
  const up = [], down = [], med = [];
  for (let h = 0; h < 24; h++) {
    const col = nums(series.map((s) => s.v[h]));
    if (!col.length) continue;
    up.push([x(h), y(Math.max(...col))]);
    down.push([x(h), y(Math.min(...col))]);
    med.push([x(h), y(median(col))]);
  }
  g += `<path d="${linePath(up)}${linePath(down.reverse()).replace("M", "L")}Z" fill="var(--muted)" fill-opacity=".16"/>`;

  for (const s of series) {
    const path = linePath(s.v.map((t, h) => (isNum(t) ? [x(h), y(t)] : null)));
    if (path) g += `<path d="${path}" fill="none" stroke="var(${s.m.c})" stroke-width="1.6" stroke-opacity=".9"/>`;
  }
  g += `<path d="${linePath(med)}" fill="none" stroke="var(--ink)" stroke-width="2.6" stroke-dasharray="6 4"/>`;
  svg.innerHTML = g;
}

function render() {
  renderStrip();
  renderMatrix();
  renderChart();
}

/* ---------- Pestañas principales ----------
 * La pestaña activa se refleja en la URL (#mapa), así se puede compartir
 * un enlace directo a los mapas y el botón "atrás" del navegador funciona. */

// Hash de la URL para cada pestaña principal.
const PAGE_HASH = { forecast: "", map: "#mapa", accuracy: "#acierto" };

function pageFromHash() {
  return Object.keys(PAGE_HASH).find((p) => PAGE_HASH[p] === location.hash) || "forecast";
}

function showPage(page) {
  state.page = page;
  $("page-forecast").hidden = page !== "forecast";
  $("page-map").hidden = page !== "map";
  $("page-accuracy").hidden = page !== "accuracy";
  $("views").querySelectorAll(".view-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.page === page)));
  updateMaps();
  if (page === "accuracy") showAccuracy();
}

/* ---------- Estados de la interfaz ---------- */

// Muestra solo uno de: "loading", "error" o "content".
function showStatus(which, message = "") {
  $("loading").hidden = which !== "loading";
  $("error").hidden = which !== "error";
  $("content").hidden = which !== "content";
  if (which === "error") $("error-msg").textContent = message;
}

// Mensaje entendible para el usuario a partir del error técnico.
function errorMessage(err) {
  if (!navigator.onLine) return "No hay conexión a internet. Comprueba la red y vuelve a intentarlo.";
  if (err.name === "AbortError") return "Open-Meteo está tardando demasiado en responder. Inténtalo de nuevo en unos segundos.";
  return `No se han podido cargar las predicciones de Open-Meteo (${err.message}). Inténtalo de nuevo en unos minutos.`;
}

/* ---------- Carga ---------- */

async function load(place) {
  state.place = place;
  $("place").textContent = place.label;
  placeToUrl(place);
  updateMaps(); // los mapas no dependen de esta petición: se actualizan aunque falle
  if (state.page === "accuracy") showAccuracy(); // el aviso de zona depende de la ciudad
  showStatus("loading");
  try {
    state.data = await fetchForecast(place.lat, place.lon);
  } catch (err) {
    console.error(err);
    showStatus("error", errorMessage(err));
    return;
  }
  state.sel = 0;
  savePlace(place);
  showStatus("content");
  render();
}

/* ---------- Eventos ---------- */

$("retry").addEventListener("click", () => load(state.place));

$("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  state.view = tab.dataset.v;
  $("tabs").querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  renderMatrix();
});

// Pestañas principales: cambiar el hash dispara "hashchange", que muestra la página.
$("views").addEventListener("click", (e) => {
  const tab = e.target.closest(".view-tab");
  if (!tab) return;
  const hash = PAGE_HASH[tab.dataset.page];
  if (location.hash !== hash) location.hash = hash;
  else showPage(tab.dataset.page);
});
window.addEventListener("hashchange", () => showPage(pageFromHash()));

// Buscador: muestra hasta 5 coincidencias y carga la elegida.
$("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  const box = $("results");
  box.innerHTML = "";
  if (!q) return;

  let j;
  try {
    j = await fetchJson("https://geocoding-api.open-meteo.com/v1/search?" + new URLSearchParams({ name: q, count: 5, language: "es" }));
  } catch (err) {
    box.textContent = "No se ha podido buscar la ciudad: " + errorMessage(err);
    return;
  }
  if (!j.results?.length) {
    box.textContent = "No encuentro esa ciudad. Prueba con otro nombre.";
    return;
  }
  for (const p of j.results) {
    const label = [p.name, p.admin1, p.country].filter(Boolean).join(", ");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label; // textContent (no innerHTML) para no inyectar HTML de la API
    b.addEventListener("click", () => {
      box.innerHTML = "";
      $("q").value = "";
      load({ lat: p.latitude, lon: p.longitude, label });
    });
    box.appendChild(b);
  }
});

/* "Usar mi ubicación": pide la posición al navegador (que pregunta al usuario).
 * Se redondea a 2 decimales (≈ 1 km): suficiente para el tiempo y no deja la
 * posición exacta en la URL si se comparte el enlace. */
$("locate").addEventListener("click", () => {
  const box = $("results");
  if (!navigator.geolocation) {
    box.textContent = "Este navegador no permite obtener tu ubicación.";
    return;
  }
  const btn = $("locate");
  btn.setAttribute("aria-busy", "true");
  box.textContent = "Buscando tu ubicación…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.removeAttribute("aria-busy");
      box.textContent = "";
      const round = (v) => Math.round(v * 100) / 100;
      load({ lat: round(pos.coords.latitude), lon: round(pos.coords.longitude), label: "Tu ubicación" });
    },
    (err) => {
      btn.removeAttribute("aria-busy");
      box.textContent = err.code === err.PERMISSION_DENIED
        ? "No has dado permiso para usar tu ubicación. Puedes buscar tu ciudad por su nombre."
        : "No se ha podido obtener tu ubicación. Prueba a buscar tu ciudad por su nombre.";
    },
    { timeout: 10000, maximumAge: 10 * 60 * 1000 },
  );
});

// Arranque: ciudad de la URL (enlace compartido), si no la última guardada, si no Arjona.
initMaps();
initAccuracy();
state.page = pageFromHash();
load(placeFromUrl() || readSavedPlace() || DEFAULT_PLACE);
showPage(state.page);
