/* Meteosainete — lógica de la app
 *
 * Flujo: load() pide la predicción de 6 modelos a Open-Meteo → normaliza los
 * datos en `state.data` → render() pinta la franja de consenso, la matriz
 * y el gráfico horario. No hay dependencias ni paso de compilación.
 */
"use strict";

/* ---------- Configuración ---------- */

// Modelos que comparamos. `id` es el nombre que usa Open-Meteo; `c` es la
// variable CSS con su color (definida en style.css).
const MODELS = [
  { id: "ecmwf_ifs025",         name: "ECMWF",        origin: "Europa",      c: "--m1" },
  { id: "gfs_seamless",         name: "GFS",          origin: "EE. UU.",     c: "--m2" },
  { id: "icon_seamless",        name: "ICON",         origin: "Alemania",    c: "--m3" },
  { id: "meteofrance_seamless", name: "Météo-France", origin: "Francia",     c: "--m4" },
  { id: "ukmo_seamless",        name: "UKMO",         origin: "Reino Unido", c: "--m5" },
  { id: "gem_seamless",         name: "GEM",          origin: "Canadá",      c: "--m6" },
];

const DEFAULT_PLACE = { lat: 37.93493, lon: -4.05478, label: "Arjona, Jaén, Andalucía, España" };

// Modelos disponibles en el mapa de Windy. `product` es el nombre que usa Windy en su URL.
const MAP_MODELS = [
  { product: "ecmwf", name: "ECMWF" },
  { product: "gfs", name: "GFS" },
  { product: "iconEu", name: "ICON-EU" },
];
const STORAGE_KEY = "meteosainete:lastPlace";
const FETCH_TIMEOUT_MS = 12000;
const DAY_NAMES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// Estado global de la interfaz.
const state = {
  data: null,     // datos normalizados (ver fetchForecast)
  view: "temp",   // pestaña activa de la matriz: temp | rain | wind
  sel: 0,         // índice del día seleccionado
  place: null,    // { lat, lon, label } de la ciudad actual
  page: "forecast", // pestaña principal: forecast | map
  mapModel: MAP_MODELS[0].product, // modelo elegido en el mapa de Windy
};

/* ---------- Utilidades ---------- */

const $ = (id) => document.getElementById(id);

const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
const nums = (arr) => arr.filter(isNum);

// Número con coma decimal (es-ES). Devuelve "—" si no hay dato.
function fmt(v, decimals = 0) {
  if (!isNum(v)) return "—";
  return v.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function median(arr) {
  const a = nums(arr).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Intensidad de la lluvia diaria en palabras.
function rainLabel(mm) {
  if (!isNum(mm)) return "";
  if (mm < 0.1) return "seco";
  if (mm < 1) return "llovizna";
  if (mm < 5) return "débil";
  if (mm < 15) return "moderada";
  if (mm < 30) return "fuerte";
  return "muy fuerte";
}

/* Estimación de probabilidad de lluvia a partir de los mm del día.
 * Se usa SOLO para modelos que no publican probabilidad (hoy, Météo-France).
 * Es una aproximación orientativa, no una probabilidad meteorológica real:
 * por eso se muestra con "≈", en cursiva, y no entra en el consenso. */
function estimateProb(mm) {
  if (!isNum(mm)) return null;
  if (mm < 0.1) return 0;
  if (mm < 1) return 30;
  if (mm < 5) return 60;
  if (mm < 15) return 80;
  return 90;
}

// Colores de fondo de las celdas según el valor.
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

function dayName(iso, i) {
  if (i === 0) return "Hoy";
  if (i === 1) return "Mañana";
  const d = new Date(iso + "T12:00"); // mediodía para evitar saltos por zona horaria
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()}`;
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

/* ---------- Datos ---------- */

// fetch con tiempo máximo: si la API no responde, mejor un error claro que una espera infinita.
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

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

// Un modelo "tiene datos" un día si da temperatura máxima ese día.
const hasDay = (o, i) => isNum(o.tmax[i]);

// ¿El modelo publica probabilidad de lluvia en algún día? (Météo-France no.)
const publishesProb = (o) => o.prob.some(isNum);

/* ---------- Consenso y fiabilidad ---------- */

/* Calcula el consenso del día i usando solo los modelos con datos ese día.
 * - Valores: mediana (resiste mejor que la media a un modelo "loco").
 * - Probabilidad: mediana de las probabilidades publicadas (nunca estimaciones).
 * - Fiabilidad:
 *     alta  → máximas a ≤ 2 °C y todos coinciden en si llueve (≥ 1 mm)
 *     media → hasta 4 °C, o la lluvia está dudosa (minoría discrepante)
 *     baja  → más de 4 °C, o los modelos están partidos (≥ 1/3 discrepa) */
function consensus(i) {
  const active = MODELS.map((m) => state.data.m[m.id]).filter((o) => hasDay(o, i));
  const col = (key) => active.map((o) => o[key][i]);

  const tmaxs = nums(col("tmax"));
  const rains = nums(col("rain"));
  const spread = tmaxs.length ? Math.max(...tmaxs) - Math.min(...tmaxs) : 0;
  const n = rains.length;
  const wet = rains.filter((v) => v >= 1).length;
  const minority = n && wet > 0 && wet < n ? Math.min(wet, n - wet) / n : 0;

  let level = "alta";
  if (spread > 4 || minority >= 0.34) level = "baja";
  else if (spread > 2 || minority > 0) level = "media";

  return {
    tmax: median(col("tmax")),
    tmin: median(col("tmin")),
    rain: median(col("rain")),
    prob: median(col("prob")),
    wind: median(col("wind")),
    spread, wet, n, level,
  };
}

/* ---------- Render ---------- */

function renderStrip() {
  const el = $("strip");
  el.innerHTML = "";
  state.data.dates.forEach((iso, i) => {
    const c = consensus(i);
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
    const c = consensus(i);
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

/* ---------- Mapa de Windy ----------
 * Windy ofrece un mapa incrustable (iframe) configurable por URL. Así tenemos
 * mapas de lluvia de cada modelo a resolución completa, sin gastar cuota de
 * Open-Meteo. Como pesa bastante, solo se carga cuando el usuario abre la sección. */

function windyUrl(place, product) {
  const p = new URLSearchParams({
    lat: place.lat, lon: place.lon,             // centro del mapa
    detailLat: place.lat, detailLon: place.lon, // posición del marcador
    zoom: 8,
    level: "surface",
    overlay: "rain",
    product,
    menu: "",
    message: "true",
    marker: "true",
    calendar: "now",
    type: "map",
    location: "coordinates",
    metricWind: "km/h",
    metricTemp: "°C",
    radarRange: "-1",
  });
  return "https://embed.windy.com/embed2.html?" + p;
}

function renderMapTabs() {
  $("map-tabs").innerHTML = MAP_MODELS.map((m) =>
    `<button type="button" class="tab" role="tab" data-p="${m.product}" aria-selected="${m.product === state.mapModel}">${m.name}</button>`
  ).join("");
}

// Actualiza el iframe solo si la pestaña de mapas está visible y la URL ha cambiado.
function updateMap() {
  if (state.page !== "map" || !state.place) return;
  const src = windyUrl(state.place, state.mapModel);
  const frame = $("windy");
  // Comparamos con la última URL guardada: frame.src la devuelve normalizada y no coincidiría.
  if (frame.dataset.url !== src) {
    frame.dataset.url = src;
    frame.src = src;
  }
}

/* ---------- Pestañas principales ----------
 * La pestaña activa se refleja en la URL (#mapa), así se puede compartir
 * un enlace directo a los mapas y el botón "atrás" del navegador funciona. */

function pageFromHash() {
  return location.hash === "#mapa" ? "map" : "forecast";
}

function showPage(page) {
  state.page = page;
  $("page-forecast").hidden = page !== "forecast";
  $("page-map").hidden = page !== "map";
  $("views").querySelectorAll(".view-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.page === page)));
  updateMap();
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
  updateMap(); // el mapa no depende de Open-Meteo: se actualiza aunque la predicción falle
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
  const hash = tab.dataset.page === "map" ? "#mapa" : "";
  if (location.hash !== hash) location.hash = hash;
  else showPage(tab.dataset.page);
});
window.addEventListener("hashchange", () => showPage(pageFromHash()));

// Mapa: al pulsar un modelo se recarga el iframe con ese modelo.
$("map-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  state.mapModel = tab.dataset.p;
  renderMapTabs();
  updateMap();
});

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

// Arranque: última ciudad guardada o Arjona.
renderMapTabs();
state.page = pageFromHash();
load(readSavedPlace() || DEFAULT_PLACE);
showPage(state.page);
