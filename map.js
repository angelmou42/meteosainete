/* Meteosainete — mapas de lluvia
 *
 * La pestaña "Mapas de lluvia" tiene dos vistas:
 *  1. Mapa propio (por defecto): una rejilla de puntos de Open-Meteo pintada
 *     sobre un mapa de Leaflet, con selector de modelo, día y hora. Se descargan
 *     los 7 días de golpe, así que cambiar de hora es instantáneo.
 *  2. Windy: mapa animado incrustado, con más detalle pero sin poder elegir la
 *     hora desde fuera (su iframe no lo permite).
 *
 * app.js solo usa initMaps() y updateMaps(); el resto se exporta para los tests.
 */
import { $, MODELS, RAIN_SCALE, dayName, fetchJson, fmt, isNum, rainColor, state } from "./core.js";

/* ---------- Configuración ---------- */

// Leaflet (librería de mapas) se descarga solo al abrir el mapa propio.
// `integrity` (SRI) hace que el navegador rechace el archivo si el CDN lo alterase.
const LEAFLET = {
  js: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  jsHash: "sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==",
  css: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  cssHash: "sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==",
};

/* Rejilla de 8 × 16 puntos separados 0,35° (≈ 35 km) alrededor de la ciudad:
 * cubre unos 460 × 270 km. Open-Meteo cuenta cada punto como una llamada y su
 * límite gratuito es de 600 por minuto y usuario, así que la rejilla es un
 * equilibrio entre zona cubierta, detalle y cuota: 128 puntos por modelo
 * (unos 4 modelos por minuto). Es más ancha que alta porque la pantalla también lo es. */
const GRID = { rows: 8, cols: 16, step: 0.35 };
const GRID_CACHE_MS = 60 * 60 * 1000; // las rejillas guardadas valen 1 hora (los modelos se actualizan cada pocas horas)
const CELL_PX = 32; // píxeles por celda al pintar (la interpolación suaviza entre puntos)

// Modelos del mapa de Windy (`product` es el nombre que usa Windy en su URL).
const WINDY_MODELS = [
  { product: "ecmwf", name: "ECMWF" },
  { product: "gfs", name: "GFS" },
  { product: "iconEu", name: "ICON-EU" },
];

// Estado de los mapas (separado del `state` de app.js para no mezclar responsabilidades).
const maps = {
  kind: "own",            // vista activa: own | windy
  model: "ecmwf_ifs025",  // modelo del mapa propio (id de Open-Meteo)
  windyModel: "ecmwf",    // modelo del mapa de Windy
  t: null,                // índice de la hora elegida (0 = hoy a las 00:00); null = hora actual
  sel: null,              // día de la Comparativa con el que se abrió el mapa (para seguirlo)
  grid: null,             // datos de la rejilla del modelo y ciudad actuales
  cache: new Map(),       // rejillas ya descargadas en esta visita, por "modelo|lat|lon"
  request: 0,             // contador para descartar respuestas de peticiones antiguas
  leaflet: null,          // promesa de carga de Leaflet
  map: null,              // instancia de L.map
  overlay: null,          // capa con la imagen de la lluvia
  marker: null,           // punto de la ciudad
  baseLayer: null,        // teselas del fondo y de los nombres (para cambiar de tema)
  labelLayer: null,
  placeKey: "",           // ciudad que está centrada ahora en el mapa
};

/* ---------- Arranque y cambios de vista ---------- */

// Pinta los botones y conecta los eventos. Se llama una vez desde app.js.
export function initMaps() {
  const modelTabs = (list, selected, key) => list.map((m) =>
    `<button type="button" class="tab" role="tab" data-${key}="${m.id || m.product}" aria-selected="${(m.id || m.product) === selected}">${m.name}</button>`
  ).join("");
  $("rain-models").innerHTML = modelTabs(MODELS, maps.model, "model");
  $("windy-models").innerHTML = modelTabs(WINDY_MODELS, maps.windyModel, "product");
  renderLegend();

  onTab("map-kind", "kind", (kind) => { maps.kind = kind; updateMaps(); });
  onTab("rain-models", "model", (model) => { maps.model = model; updateMaps(); });
  onTab("windy-models", "product", (product) => { maps.windyModel = product; updateMaps(); });

  $("map-days").addEventListener("click", (e) => {
    const chip = e.target.closest(".daychip");
    if (chip) setHour(Number(chip.dataset.day) * 24 + (maps.t % 24));
  });
  $("map-hour").addEventListener("input", (e) => setHour(Math.floor(maps.t / 24) * 24 + Number(e.target.value)));
  $("hour-prev").addEventListener("click", () => setHour(maps.t - 1));
  $("hour-next").addEventListener("click", () => setHour(maps.t + 1));
}

// Conecta un grupo de pestañas: marca la pulsada y llama a `onSelect` con su data-<key>.
function onTab(containerId, key, onSelect) {
  const box = $(containerId);
  box.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    box.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    onSelect(tab.dataset[key]);
  });
}

// Se llama al abrir la pestaña de mapas y al cambiar de ciudad.
export function updateMaps() {
  if (state.page !== "map" || !state.place) return;
  $("own-map-box").hidden = maps.kind !== "own";
  $("windy-box").hidden = maps.kind !== "windy";
  if (maps.kind === "own") showOwnMap();
  else updateWindy();
}

/* ---------- Mapa propio: datos ---------- */

// Descarga la lluvia horaria de un modelo en todos los puntos de la rejilla (una sola petición).
async function fetchGrid(place, model) {
  const { rows, cols, step } = GRID;
  const { lat0, lon0 } = gridBounds(place);
  const lats = [], lons = [];
  for (let r = 0; r < rows; r++) {        // de sur a norte
    for (let c = 0; c < cols; c++) {      // de oeste a este
      lats.push((lat0 + r * step).toFixed(3));
      lons.push((lon0 + c * step).toFixed(3));
    }
  }
  const params = new URLSearchParams({
    latitude: lats.join(","),
    longitude: lons.join(","),
    hourly: "precipitation", // mm caídos en la hora anterior
    models: model,
    forecast_days: 7,
    timezone: "auto",
  });
  const j = await fetchJson("https://api.open-meteo.com/v1/forecast?" + params);
  if (!Array.isArray(j) || j.length !== rows * cols) throw new Error("Respuesta inesperada de la API");

  return {
    times: j[0].hourly.time,
    offset: j[0].utc_offset_seconds, // desfase horario de la ciudad, para saber qué hora es allí
    lat0, lon0,
    values: j.map((p) => p.hourly.precipitation), // values[punto][hora]
    savedAt: Date.now(),
  };
}

/* Devuelve la rejilla de un modelo buscando primero en memoria, después en
 * sessionStorage (sobrevive a recargar la página) y, si no, descargándola.
 * Así recargar o volver a un modelo ya visto no gasta cuota de Open-Meteo. */
async function getGrid(place, model) {
  const key = `${model}|${place.lat}|${place.lon}`;
  const storageKey = "meteosainete:grid:" + key;
  const fresh = (g) => g && Date.now() - g.savedAt < GRID_CACHE_MS;

  let grid = maps.cache.get(key);
  if (!fresh(grid)) {
    try { grid = JSON.parse(sessionStorage.getItem(storageKey)); } catch { grid = null; }
  }
  if (!fresh(grid)) {
    setMapMessage(`Descargando ${modelName(model)}…`);
    grid = await fetchGrid(place, model);
    try { sessionStorage.setItem(storageKey, JSON.stringify(grid)); } catch { /* sin espacio o bloqueado: no pasa nada */ }
  }
  maps.cache.set(key, grid);
  return grid;
}

/* Índice de la hora en curso en la zona horaria de la ciudad. Cada valor es la
 * lluvia de la hora anterior, así que a las 14:30 la hora en curso (14–15 h)
 * es la que tiene marca "15:00": de ahí el +1. */
export function currentIndex(grid) {
  const localNow = new Date(Date.now() + grid.offset * 1000).toISOString().slice(0, 13) + ":00";
  const i = grid.times.indexOf(localNow);
  return i < 0 ? 0 : Math.min(i + 1, grid.times.length - 1);
}

// Esquina suroeste y límites [[sur, oeste], [norte, este]] de la rejilla centrada en `place`.
export function gridBounds(place) {
  const { rows, cols, step } = GRID;
  const lat0 = place.lat - ((rows - 1) / 2) * step;
  const lon0 = place.lon - ((cols - 1) / 2) * step;
  return { lat0, lon0, bounds: [[lat0, lon0], [lat0 + (rows - 1) * step, lon0 + (cols - 1) * step]] };
}

// Valor de un punto de la rejilla (fila r desde el sur, columna c desde el oeste) a la hora t.
function gridValue(grid, r, c, t) {
  const v = grid.values[r * GRID.cols + c][t];
  return isNum(v) ? v : null;
}

/* ---------- Mapa propio: Leaflet ---------- */

// Inserta el CSS y el JS de Leaflet una sola vez y devuelve una promesa que se cumple al cargar.
function loadLeaflet() {
  if (maps.leaflet) return maps.leaflet;
  const add = (tag, attrs) => new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement(tag), attrs, { crossOrigin: "anonymous" });
    el.onload = resolve;
    el.onerror = () => reject(new Error("No se pudo cargar la librería de mapas"));
    document.head.appendChild(el);
  });
  maps.leaflet = Promise.all([
    add("link", { rel: "stylesheet", href: LEAFLET.css, integrity: LEAFLET.cssHash }),
    add("script", { src: LEAFLET.js, integrity: LEAFLET.jsHash }),
  ]).catch((err) => { maps.leaflet = null; throw err; }); // permite reintentar
  return maps.leaflet;
}

// Crea el mapa la primera vez: fondo sin nombres, capa de lluvia y nombres por encima.
// Teselas grises de Esri en el tema actual de la web (claro u oscuro).
function tileUrl(layer) {
  const root = document.documentElement.dataset.theme;
  const dark = root ? root === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark ? "Dark" : "Light"}_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`;
}

// Al cambiar el tema con el botón de la cabecera, el mapa base cambia también.
export function setMapTheme() {
  maps.baseLayer?.setUrl(tileUrl("Base"));
  maps.labelLayer?.setUrl(tileUrl("Reference"));
}

function createMap() {
  // Mapa base gris de Esri (gratuito, sin clave): en gris los colores de la lluvia destacan.
  // Viene en dos capas, fondo y nombres, para poder poner la lluvia en medio.
  const attribution = 'Mapa &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap · Datos: Open-Meteo';

  // Sin zoom con la rueda: al bajar por la página no queremos que el mapa se aleje sin querer.
  const map = L.map("rainmap", { zoomSnap: 0.25, maxZoom: 11, scrollWheelZoom: false });
  // Paneles para controlar el orden: fondo (200) < lluvia (350) < nombres (450).
  map.createPane("rain").style.zIndex = 350;
  map.createPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
  maps.baseLayer = L.tileLayer(tileUrl("Base"), { attribution, maxNativeZoom: 16 }).addTo(map);
  maps.labelLayer = L.tileLayer(tileUrl("Reference"), { pane: "labels", maxNativeZoom: 16 }).addTo(map);

  // Al pulsar el mapa, muestra los mm del punto de la rejilla más cercano.
  map.on("click", (e) => {
    const g = maps.grid;
    if (!g) return;
    const r = Math.round((e.latlng.lat - g.lat0) / GRID.step);
    const c = Math.round((e.latlng.lng - g.lon0) / GRID.step);
    if (r < 0 || r >= GRID.rows || c < 0 || c >= GRID.cols) return;
    const v = gridValue(g, r, c, maps.t);
    const text = v == null ? "Sin datos a esta hora" : v < 0.1 ? "Sin lluvia" : `${fmt(v, 1)} mm en esa hora`;
    L.popup().setLatLng(e.latlng).setContent(`<b>${text}</b><br>${hourRange(maps.t)} · ${modelName(maps.model)}`).openOn(map);
  });
  return map;
}

/* Encaja el mapa en la zona de la rejilla: zoom mínimo justo para que la
 * pantalla quede siempre dentro de la zona con datos (sin bordes vacíos) y sin
 * poder arrastrar fuera de ella. */
function fitMapToGrid(place) {
  const bounds = L.latLngBounds(gridBounds(place).bounds);
  const map = maps.map;
  map.setMaxBounds(null).setMinZoom(0);
  const zoom = map.getBoundsZoom(bounds, true);
  map.setMinZoom(zoom).setView([place.lat, place.lon], zoom).setMaxBounds(bounds);
  map.options.maxBoundsViscosity = 1;
}

async function showOwnMap() {
  const place = state.place;
  const placeKey = `${place.lat}|${place.lon}`;
  const request = ++maps.request;

  try {
    if (!window.L) setMapMessage("Cargando mapa…");
    await loadLeaflet();
    if (!maps.map) maps.map = createMap();
    maps.map.invalidateSize(); // por si el contenedor estaba oculto al crearse

    // Al cambiar de ciudad: centrar el mapa, mover el punto y volver a la hora actual.
    if (maps.placeKey !== placeKey) {
      maps.placeKey = placeKey;
      maps.t = null;
      maps.sel = null;
      fitMapToGrid(place);
      const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
      if (maps.marker) maps.marker.remove();
      maps.marker = L.circleMarker([place.lat, place.lon], { radius: 5, color: ink, weight: 2, fillOpacity: 0.9, interactive: false }).addTo(maps.map);
    }

    const grid = await getGrid(place, maps.model);
    if (request !== maps.request) return; // el usuario ya pidió otra cosa mientras tanto
    maps.grid = grid;
    // Hora inicial: la actual; o, si en la Comparativa se eligió otro día, ese día a mediodía.
    // La Comparativa llega a 14 días y el mapa solo a 7: más allá, se abre en la hora actual.
    if (maps.t == null || maps.sel !== state.sel) {
      const noon = state.sel * 24 + 13; // marca 13:00 = lluvia de 12 a 13 h
      maps.t = state.sel && noon < grid.times.length ? noon : currentIndex(grid);
      maps.sel = state.sel;
    }
    maps.t = Math.min(maps.t, grid.times.length - 1);
    renderTimeControls();
    drawRain();
  } catch (err) {
    if (request !== maps.request) return;
    console.error(err);
    setMapMessage(mapErrorMessage(err), true);
  }
}

function mapErrorMessage(err) {
  if (!navigator.onLine) return "No hay conexión a internet.";
  if (err.message === "HTTP 429") return "Open-Meteo pide esperar un minuto: se han descargado muchos mapas seguidos.";
  if (err.name === "AbortError") return "Open-Meteo está tardando demasiado en responder.";
  return `No se ha podido cargar el mapa (${err.message}).`;
}

/* ---------- Mapa propio: dibujo ---------- */

/* Pinta la lluvia de la hora elegida en un <canvas> y lo coloca sobre el mapa.
 * Entre puntos de la rejilla se usa interpolación bilineal (media ponderada de
 * los 4 puntos vecinos) para que no se vean cuadrados. */
function drawRain() {
  const g = maps.grid, t = maps.t;
  const { rows, cols } = GRID;
  const W = (cols - 1) * CELL_PX, H = (rows - 1) * CELL_PX;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  let hasData = false, hasRain = false;

  for (let py = 0; py < H; py++) {
    const fy = (H - py - 0.5) / CELL_PX;          // filas desde el sur (el canvas empieza arriba)
    const r = Math.min(Math.floor(fy), rows - 2), ty = fy - r;
    for (let px = 0; px < W; px++) {
      const fx = (px + 0.5) / CELL_PX;
      const c = Math.min(Math.floor(fx), cols - 2), tx = fx - c;
      const a = gridValue(g, r, c, t), b = gridValue(g, r, c + 1, t);
      const d = gridValue(g, r + 1, c, t), e = gridValue(g, r + 1, c + 1, t);
      if (a == null || b == null || d == null || e == null) continue; // sin datos: transparente
      hasData = true;
      const v = bilinear(a, b, d, e, tx, ty);
      const color = rainColor(v);
      if (!color) continue;
      hasRain = true;
      const i = (py * W + px) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
      img.data[i + 3] = Math.round(color[3] * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  maps.map.closePopup(); // el valor que mostraba ya no corresponde a la hora o modelo actual

  // La imagen cubre desde el punto suroeste hasta el noreste de la rejilla.
  const bounds = gridBounds(state.place).bounds;
  const url = canvas.toDataURL();
  if (maps.overlay) {
    maps.overlay.setUrl(url);
    maps.overlay.setBounds(L.latLngBounds(bounds));
  } else {
    maps.overlay = L.imageOverlay(url, bounds, { pane: "rain", interactive: false }).addTo(maps.map);
  }

  if (!hasData) setMapMessage(`${modelName(maps.model)} no llega a esta hora: su predicción tiene menos alcance.`);
  else if (!hasRain) setMapMessage("Sin lluvia en la zona a esta hora");
  else setMapMessage("");
}

/* Interpolación bilineal: valor en (tx, ty) ∈ [0, 1]² dentro de una celda,
 * a partir de sus esquinas a (suroeste), b (sureste), d (noroeste) y e (noreste). */
export function bilinear(a, b, d, e, tx, ty) {
  return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
}

/* ---------- Mapa propio: controles de día y hora ---------- */

function setHour(t) {
  if (!maps.grid) return;
  maps.t = Math.max(0, Math.min(maps.grid.times.length - 1, t));
  renderTimeControls();
  drawRain();
}

// "13:00–14:00": la lluvia de cada hora es la caída durante la hora anterior.
export function hourRange(t) {
  const h = t % 24;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad((h + 23) % 24)}:00–${pad(h)}:00`;
}

function renderTimeControls() {
  const g = maps.grid, day = Math.floor(maps.t / 24);
  const days = g.times.length / 24;
  let html = "";
  for (let d = 0; d < days; d++) {
    html += `<button type="button" class="daychip" data-day="${d}" aria-pressed="${d === day}">${dayName(g.times[d * 24].slice(0, 10), d)}</button>`;
  }
  const box = $("map-days");
  box.innerHTML = html;
  // En móvil no caben todos los días: desplaza la fila para que se vea el elegido.
  const chip = box.children[day];
  box.scrollLeft = chip.offsetLeft - box.offsetLeft - (box.clientWidth - chip.offsetWidth) / 2;
  $("map-hour").value = maps.t % 24;
  $("map-hour-label").textContent = hourRange(maps.t);
  $("hour-prev").disabled = maps.t === 0;
  $("hour-next").disabled = maps.t === g.times.length - 1;
}

function renderLegend() {
  $("rain-legend").innerHTML = RAIN_SCALE.map(({ mm, rgba }) =>
    `<span><i style="background:rgba(${rgba.join(",")})"></i>${fmt(mm, mm < 1 ? 1 : 0)}</span>`
  ).join("") + "<span>mm/h</span>";
}

// Mensaje sobre el mapa (cargando, error, sin lluvia…). Vacío = ocultarlo.
function setMapMessage(text, isError = false) {
  const el = $("rainmap-msg");
  el.hidden = !text;
  el.classList.toggle("is-error", isError);
  el.innerHTML = "";
  if (!text) return;
  el.append(text);
  if (isError) {
    const retry = Object.assign(document.createElement("button"), { type: "button", textContent: "Reintentar" });
    retry.addEventListener("click", showOwnMap);
    el.append(retry);
  }
}

const modelName = (id) => MODELS.find((m) => m.id === id)?.name || id;

/* ---------- Windy ----------
 * Iframe incrustable configurable por URL: mapa animado con la rejilla completa
 * de cada modelo. Pesa bastante, así que solo se carga al elegir esta vista. */

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

// Actualiza el iframe solo si la URL ha cambiado.
function updateWindy() {
  const src = windyUrl(state.place, maps.windyModel);
  const frame = $("windy");
  // Comparamos con la última URL guardada: frame.src la devuelve normalizada y no coincidiría.
  if (frame.dataset.url !== src) {
    frame.dataset.url = src;
    frame.src = src;
  }
}
