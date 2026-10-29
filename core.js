/* Meteosainete — núcleo compartido
 *
 * Configuración, estado y funciones que usan los demás módulos (app.js,
 * map.js, acierto.js). Casi todo son funciones puras, sin tocar la página,
 * así que se pueden probar con tests en Node (carpeta tests/).
 */

/* ---------- Configuración ---------- */

// Modelos que comparamos. `id` es el nombre que usa Open-Meteo; `c` es la
// variable CSS con su color (definida en style.css); `short`, un nombre corto
// para los sitios estrechos (si no hay, se usa `name`).
export const MODELS = [
  { id: "ecmwf_ifs025",         name: "ECMWF",        origin: "Europa",      c: "--m1" },
  { id: "gfs_seamless",         name: "GFS",          origin: "EE. UU.",     c: "--m2" },
  { id: "icon_seamless",        name: "ICON",         origin: "Alemania",    c: "--m3" },
  { id: "meteofrance_seamless", name: "Météo-France", origin: "Francia",     c: "--m4", short: "Météo-Fr." },
  { id: "ukmo_seamless",        name: "UKMO",         origin: "Reino Unido", c: "--m5" },
  { id: "gem_seamless",         name: "GEM",          origin: "Canadá",      c: "--m6" },
];

const FETCH_TIMEOUT_MS = 12000;
const DAY_NAMES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// Estado global de la interfaz (un objeto compartido: los módulos leen y escriben sus campos).
export const state = {
  data: null,       // datos normalizados (ver fetchForecast en app.js)
  view: "temp",     // pestaña activa de la matriz: temp | rain | wind
  chart: "temp",    // gráfico horario: temp | rain
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

/* ---------- Lluvia por horas ---------- */

// Escala de lluvia en mm por hora (la usan el mapa y el gráfico). Por debajo del primer valor no se pinta.
export const RAIN_SCALE = [
  { mm: 0.1, rgba: [160, 210, 255, 0.3] },
  { mm: 0.5, rgba: [90, 165, 255, 0.55] },
  { mm: 1,   rgba: [40, 110, 240, 0.7] },
  { mm: 2,   rgba: [30, 185, 120, 0.75] },
  { mm: 4,   rgba: [245, 205, 40, 0.8] },
  { mm: 8,   rgba: [245, 125, 30, 0.85] },
  { mm: 16,  rgba: [220, 40, 60, 0.9] },
  { mm: 30,  rgba: [170, 40, 200, 0.9] },
];

// Color [r, g, b, a] para un valor de lluvia, o null si no llega al mínimo.
export function rainColor(mm) {
  let found = null;
  for (const step of RAIN_SCALE) if (mm >= step.mm) found = step.rgba;
  return found;
}

/* Lluvia de cada hora del día i según cada modelo: una fila por modelo (orden
 * de MODELS) con 24 franjas, la franja k va de las k a las k+1 h.
 * Open-Meteo marca cada valor con la hora en que termina, así que la franja k
 * es la marca i*24 + k + 1 (la de 00–01 h es la marca de la 01:00). */
export function hourlyRain(data, i) {
  return MODELS.map((m) => {
    const arr = data.m[m.id]?.hrain || [];
    return Array.from({ length: 24 }, (_, k) => {
      const v = arr[i * 24 + k + 1];
      return isNum(v) ? v : null;
    });
  });
}

/* Resumen de cada franja horaria: mediana, mínimo y máximo entre modelos, y si
 * "llueve": más de la mitad de los modelos con datos dan 0,1 mm o más (con un
 * empate, la mediana podría ser 0 y la web diría "sin lluvia" a la vez). */
export function rainSlots(rows) {
  return Array.from({ length: 24 }, (_, k) => {
    const vals = nums(rows.map((r) => r[k]));
    const wet = vals.filter((v) => v >= 0.1).length;
    return {
      median: median(vals),
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
      n: vals.length,
      wet,
      rainy: wet * 2 > vals.length,
    };
  });
}

/* Tramos seguidos de lluvia a partir de la franja `from`: [[desde, hasta], …] en horas.
 * Una sola hora seca entre dos tramos los une: "de 15 a 20 h" se lee mejor
 * que "de 15 a 17 h y de 18 a 20 h". */
export function rainPeriods(slots, from = 0) {
  const periods = [];
  let start = null;
  for (let k = from; k <= 24; k++) {
    const rainy = k < 24 && slots[k].rainy;
    if (rainy && start === null) start = k;
    if (!rainy && start !== null) {
      const last = periods[periods.length - 1];
      if (last && start - last[1] <= 1) last[1] = k;
      else periods.push([start, k]);
      start = null;
    }
  }
  return periods;
}

// "de 15 a 19 h", "de 6 a 9 h y de 15 a 19 h", "todo el día"…
export function formatPeriods(periods, short = false) {
  if (!periods.length) return "";
  if (periods.length === 1 && periods[0][0] === 0 && periods[0][1] === 24) return "todo el día";
  if (short) return periods.length > 2 ? "a ratos" : periods.map(([a, b]) => `${a}–${b} h`).join(" y ");
  const parts = periods.map(([a, b]) => `de ${a} a ${b} h`);
  return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " y " + parts[parts.length - 1];
}

/* Frase resumen de la lluvia del día i, para leer de un vistazo:
 *   "Lluvia débil de 15 a 19 h. 5 de 6 modelos dan algo de lluvia."
 * `from` es la primera franja a tener en cuenta (para hoy, la hora actual:
 * la lluvia que ya pasó no interesa). Devuelve { text, tone } con tone
 * "dry" (seco), "rain" (lluvia clara) o "doubt" (los modelos no se ponen de acuerdo). */
export function daySummary(data, i, from = 0) {
  const active = MODELS.map((m) => data.m[m.id]).filter((o) => o && hasDay(o, i));
  if (!active.length) return { text: "Sin datos para este día.", tone: "doubt" };
  const rows = hourlyRain(data, i);
  const slots = rainSlots(rows);
  const periods = rainPeriods(slots, from);

  // Lluvia de cada modelo desde la franja `from` hasta el final del día (para hoy, la que queda).
  // Solo cuentan los modelos que llegan a este día (los mismos que en el consenso).
  const totals = rows
    .filter((_, r) => hasDay(data.m[MODELS[r].id] || { tmax: [] }, i))
    .map((r) => nums(r.slice(from)).reduce((a, b) => a + b, 0));
  const n = totals.length;
  const wetModels = totals.filter((v) => v >= 0.1).length;
  // Aquí cuenta cualquier lluvia (≥ 0,1 mm); el "Lo dan X de N" de las tarjetas cuenta solo ≥ 1 mm.
  const agreement = wetModels === n ? `Los ${n} modelos dan lluvia.` : `${wetModels} de ${n} modelos dan algo de lluvia.`;

  if (periods.length) {
    const label = rainLabel(median(totals));
    const what = { llovizna: "Llovizna", débil: "Lluvia débil", moderada: "Lluvia moderada", fuerte: "Lluvia fuerte", "muy fuerte": "Lluvia muy fuerte" }[label] || "Algo de lluvia";
    return { text: `${what} ${formatPeriods(periods)}. ${agreement}`, tone: wetModels * 3 >= n * 2 ? "rain" : "doubt" };
  }
  if (from > 0 && rainPeriods(slots).length) return { text: "No se espera más lluvia hoy.", tone: "dry" };
  if (wetModels === 0) return { text: `Sin lluvia. Los ${n} modelos están de acuerdo.`, tone: "dry" };
  if (wetModels * 2 > n) return { text: `Algo de lluvia débil, sin hora clara: ${agreement[0].toLowerCase()}${agreement.slice(1)}`, tone: "doubt" };
  return { text: `Probablemente seco, aunque ${wetModels} de ${n} modelos dan algo de lluvia.`, tone: "doubt" };
}

/* ---------- Cielo e iconos ---------- */

const SNOW_CODES = [71, 73, 75, 77, 85, 86];      // códigos WMO de nieve
const FOG_CODES = [45, 48];                       // niebla
const isStorm = (c) => c >= 95;                   // tormenta

// ¿Cumplen más de la mitad de los elementos la condición?
const majority = (items, test) => items.length > 0 && items.filter(test).length * 2 > items.length;

/* Icono del tiempo para el día i, decidido con el mismo criterio de "mayoría
 * de modelos" que el resto de la web, para que nunca contradiga a la frase:
 *  - Lluvia: si hay alguna franja con lluvia entre rainFrom y rainTo. "rain" si
 *    la mediana de lo que dan los modelos llega a 1 mm, si no "drizzle".
 *    Se convierte en "storm" o "snow" si la mayoría de los modelos lo dicen.
 *  - Sin lluvia: niebla si la mayoría la dan; si no, según la nubosidad
 *    media entre skyFrom y skyTo (despejado < 30 %, poco nuboso < 70 %).
 *  - night: usa la luna en vez del sol. */
export function skyIcon(data, i, { rainFrom = 0, rainTo = 24, skyFrom = 8, skyTo = 20, night = false } = {}) {
  const ids = MODELS.map((m) => m.id).filter((id) => data.m[id] && hasDay(data.m[id], i));
  if (!ids.length) return "cloudy";
  const hours = (arr, from, to) => (arr || []).slice(i * 24 + from, i * 24 + to);
  const codes = ids.map((id) => nums(hours(data.m[id].hcode, rainFrom, rainTo)));

  const rows = hourlyRain(data, i);
  const slots = rainSlots(rows).slice(rainFrom, rainTo);
  if (slots.some((s) => s.rainy)) {
    if (majority(codes, (c) => c.some(isStorm))) return "storm";
    if (majority(codes, (c) => c.some((x) => SNOW_CODES.includes(x)))) return "snow";
    const totals = MODELS.map((m, r) => (ids.includes(m.id) ? nums(rows[r].slice(rainFrom, rainTo)).reduce((a, b) => a + b, 0) : null));
    return median(totals) >= 1 ? "rain" : "drizzle";
  }

  const skyCodes = ids.map((id) => nums(hours(data.m[id].hcode, skyFrom, skyTo)));
  const span = skyTo - skyFrom;
  if (majority(skyCodes, (c) => c.filter((x) => FOG_CODES.includes(x)).length * 2 >= Math.max(1, span / 2))) return "fog";

  const cloud = median(ids.map((id) => {
    const v = nums(hours(data.m[id].hcloud, skyFrom, skyTo));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }));
  if (!isNum(cloud) || cloud >= 70) return "cloudy";
  if (cloud >= 30) return night ? "partly-night" : "partly";
  return night ? "clear-night" : "clear";
}

// ¿Es de noche a la hora h (0–23) del día i? Usa la salida y puesta de sol de la API.
export function isNight(data, i, h) {
  const toHour = (iso) => (iso ? Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60 : null);
  const rise = toHour(data.sun?.rise?.[i]), set = toHour(data.sun?.set?.[i]);
  if (rise == null || set == null) return h < 7 || h >= 20;
  return h + 0.5 < rise || h + 0.5 > set;
}

// Temperatura del consenso (mediana de los modelos) a la hora h del día i.
export function tempAt(data, i, h) {
  return median(MODELS.map((m) => data.m[m.id]?.hourly?.[i * 24 + h]));
}

/* ---------- Avisos propios ----------
 * Calculados con el consenso de los modelos, no son los avisos oficiales de
 * AEMET (esos necesitan su API con clave). Umbrales sencillos y conocidos. */
export const ALERT_RULES = [
  { id: "helada", label: "Heladas", test: (c) => c.tmin <= 0, why: (c) => `mínima de ${fmt(c.tmin)} °C` },
  { id: "calor", label: "Calor", test: (c) => c.tmax >= 35, why: (c) => `máxima de ${fmt(c.tmax)} °C` },
  { id: "viento", label: "Viento fuerte", test: (c) => c.wind >= 50, why: (c) => `hasta ${fmt(c.wind)} km/h` },
  { id: "lluvia", label: "Lluvia fuerte", test: (c) => c.rain >= 20, why: (c) => `${fmt(c.rain)} mm en el día` },
];

// Avisos que salen para un día a partir de su consenso (ver consensus()).
export function dayAlerts(c) {
  return ALERT_RULES.filter((r) => isNum(c[{ helada: "tmin", calor: "tmax", viento: "wind", lluvia: "rain" }[r.id]]) && r.test(c))
    .map((r) => ({ id: r.id, label: r.label, why: r.why(c) }));
}
