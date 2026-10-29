/* Meteosainete — núcleo compartido
 *
 * Configuración, estado y funciones que usan los demás módulos (app.js,
 * map.js, acierto.js). Casi todo son funciones puras, sin tocar la página,
 * así que se pueden probar con tests en Node (carpeta tests/).
 */

/* ---------- Configuración ---------- */

// Modelos que comparamos. `id` es el nombre que usa Open-Meteo; `c` es la
// variable CSS con su color (definida en style.css).
export const MODELS = [
  { id: "ecmwf_ifs025",         name: "ECMWF",        origin: "Europa",      c: "--m1" },
  { id: "gfs_seamless",         name: "GFS",          origin: "EE. UU.",     c: "--m2" },
  { id: "icon_seamless",        name: "ICON",         origin: "Alemania",    c: "--m3" },
  { id: "meteofrance_seamless", name: "Météo-France", origin: "Francia",     c: "--m4" },
  { id: "ukmo_seamless",        name: "UKMO",         origin: "Reino Unido", c: "--m5" },
  { id: "gem_seamless",         name: "GEM",          origin: "Canadá",      c: "--m6" },
];

const FETCH_TIMEOUT_MS = 12000;
const DAY_NAMES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// Estado global de la interfaz (un objeto compartido: los módulos leen y escriben sus campos).
export const state = {
  data: null,       // datos normalizados (ver fetchForecast en app.js)
  view: "temp",     // pestaña activa de la matriz: temp | rain | wind
  sel: 0,           // índice del día seleccionado
  place: null,      // { lat, lon, label } de la ciudad actual
  page: "forecast", // pestaña principal: forecast | map | accuracy
};

/* ---------- Utilidades ---------- */

export const $ = (id) => document.getElementById(id);

export const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
export const nums = (arr) => arr.filter(isNum);

// Número con coma decimal (es-ES). Devuelve "—" si no hay dato.
export function fmt(v, decimals = 0) {
  if (!isNum(v)) return "—";
  return v.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Mediana ignorando los huecos (null). Devuelve null si no hay ningún valor.
export function median(arr) {
  const a = nums(arr).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Intensidad de la lluvia diaria en palabras.
export function rainLabel(mm) {
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
export function estimateProb(mm) {
  if (!isNum(mm)) return null;
  if (mm < 0.1) return 0;
  if (mm < 1) return 30;
  if (mm < 5) return 60;
  if (mm < 15) return 80;
  return 90;
}

export function dayName(iso, i) {
  if (i === 0) return "Hoy";
  if (i === 1) return "Mañana";
  const d = new Date(iso + "T12:00"); // mediodía para evitar saltos por zona horaria
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()}`;
}

// fetch con tiempo máximo: si la API no responde, mejor un error claro que una espera infinita.
export async function fetchJson(url) {
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

/* ---------- Consenso y fiabilidad ---------- */

// Un modelo "tiene datos" un día si da temperatura máxima ese día.
export const hasDay = (o, i) => isNum(o.tmax[i]);

// ¿El modelo publica probabilidad de lluvia en algún día? (Météo-France no.)
export const publishesProb = (o) => o.prob.some(isNum);

/* Calcula el consenso del día i usando solo los modelos con datos ese día.
 * `data` tiene la forma { m: { ecmwf_ifs025: { tmax, tmin, rain, prob, wind }, ... } }.
 * - Valores: mediana (resiste mejor que la media a un modelo "loco"; en
 *   analisis/consenso_ponderado.py se comprobó que ponderar no mejora).
 * - Probabilidad: mediana de las probabilidades publicadas (nunca estimaciones).
 * - Fiabilidad:
 *     alta  → máximas a ≤ 2 °C y todos coinciden en si llueve (≥ 1 mm)
 *     media → hasta 4 °C, o la lluvia está dudosa (minoría discrepante)
 *     baja  → más de 4 °C, o los modelos están partidos (≥ 1/3 discrepa) */
export function consensus(data, i) {
  const active = MODELS.map((m) => data.m[m.id]).filter((o) => o && hasDay(o, i));
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
