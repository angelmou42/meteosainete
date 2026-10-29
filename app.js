/* Meteosainete — módulo principal
 *
 * Flujo: load() pide la predicción de 6 modelos a Open-Meteo → normaliza los
 * datos en `state.data` → render() pinta la franja de consenso, la matriz
 * y el gráfico horario. Las utilidades y el cálculo del consenso están en
 * core.js; los mapas de lluvia en map.js y la pestaña de acierto en acierto.js.
 */
import { $, MODELS, RAIN_SCALE, consensus, daySummary, dayName, estimateProb, fetchJson, fmt, formatPeriods, hourlyRain, isNum,
  median, nums, publishesProb, rainColor, rainLabel, rainPeriods, rainSlots, state } from "./core.js";
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
 *   { dates, offset, m: { ecmwf_ifs025: { tmax, tmin, rain, prob, wind, hourly, hrain }, ... } }
 * Los días fuera del alcance de un modelo llegan como null. */
async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: "auto",
    forecast_days: 7,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    hourly: "temperature_2m,precipitation",
    models: MODELS.map((m) => m.id).join(","),
  });
  const j = await fetchJson("https://api.open-meteo.com/v1/forecast?" + params);
  if (!j.daily || !j.hourly) throw new Error("Respuesta inesperada de la API");

  const days = j.daily.time.length;
  // Si una variable no viene, la rellenamos con null para no romper el render.
  const pick = (block, name, len, id) => j[block][`${name}_${id}`] || Array(len).fill(null);

  // offset: desfase horario de la ciudad (segundos), para saber qué hora es allí.
  const out = { dates: j.daily.time, offset: j.utc_offset_seconds, m: {} };
  for (const { id } of MODELS) {
    const hours = j.hourly.time.length;
    out.m[id] = {
      tmax: pick("daily", "temperature_2m_max", days, id),
      tmin: pick("daily", "temperature_2m_min", days, id),
      rain: pick("daily", "precipitation_sum", days, id),
      prob: pick("daily", "precipitation_probability_max", days, id),
      wind: pick("daily", "wind_speed_10m_max", days, id),
      hourly: pick("hourly", "temperature_2m", hours, id),
      hrain: pick("hourly", "precipitation", hours, id), // mm caídos en la hora anterior a cada marca
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
    // Horas de lluvia del día (por ejemplo "15–19 h"), cuando más de la mitad de los modelos la dan.
    const when = formatPeriods(rainPeriods(rainSlots(hourlyRain(state.data, i))), true);
    // El total diario de Open-Meteo va de 23 a 23 h y las franjas de 0 a 24 h: si la lluvia cae
    // justo al final del día, el total puede salir 0 aunque haya horas de lluvia.
    const rainTxt = c.rain >= 0.1 ? `${fmt(c.rain, 1)} mm, ${rainLabel(c.rain)}` : when ? "algo de lluvia" : "sin lluvia";
    const whenTxt = when ? ` · <span class="when">${when}</span>` : "";

    const b = document.createElement("button");
    b.type = "button";
    b.className = "day";
    b.setAttribute("aria-pressed", String(i === state.sel));
    b.innerHTML = `
      <span class="dname">${dayName(iso, i)}</span>
      <span class="temps">${fmt(c.tmax)}°<small> / ${fmt(c.tmin)}°</small></span>
      <span class="rain">${probTxt}${rainTxt}${whenTxt}<br>Lo dan ${c.wet} de ${c.n} modelos</span>
      <span class="chip c-${c.level}">Fiabilidad ${c.level}</span>`;
    b.addEventListener("click", () => { state.sel = i; render(); });
    el.appendChild(b);
  });
  $("strip-title").textContent = `Consenso de ${MODELS.length} modelos`;
}

// Hora actual (0–23) en la zona horaria de la ciudad.
function localHour() {
  return new Date(Date.now() + (state.data.offset || 0) * 1000).getUTCHours();
}

// Frase resumen del día seleccionado. Para hoy solo cuenta la lluvia que queda por venir.
function renderHeadline() {
  const i = state.sel;
  const { text, tone } = daySummary(state.data, i, i === 0 ? localHour() : 0);
  const el = $("headline");
  el.className = `headline t-${tone}`;
  el.innerHTML = `<b>${dayName(state.data.dates[i], i)}:</b> ${text}`;
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

// Gráfico del día seleccionado: temperatura o lluvia según la pestaña.
function renderChart() {
  const name = dayName(state.data.dates[state.sel], state.sel).toLowerCase();
  const rain = state.chart === "rain";
  $("chart-title").textContent = `${rain ? "Lluvia" : "Temperatura"} hora a hora · ${name}`;
  $("chart-note").textContent = rain
    ? "Barras: mediana de los modelos (la raya va del que menos al que más da). Debajo, la lluvia de cada modelo hora a hora."
    : "La banda gris es el rango entre modelos; la línea discontinua, la mediana.";
  if (rain) renderRainChart();
  else renderTempChart();
}

function renderTempChart() {
  const svg = $("chart");
  const d = state.data;
  const i = state.sel;
  const W = 720, H = 260, L = 36, R = 12, T = 14, B = 28; // tamaño y márgenes
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", "Temperatura por horas según cada modelo");

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

/* Lluvia por horas: arriba, barras con la mediana de los modelos y una raya
 * del mínimo al máximo; debajo, una fila por modelo con cada hora coloreada
 * según los mm (como un mapa de calor), para ver si coinciden en el "cuándo". */
function renderRainChart() {
  const svg = $("chart");
  const rows = hourlyRain(state.data, state.sel);
  const slots = rainSlots(rows);
  const W = 720, L = 92, R = 12, T = 14, BARS = 110, GAP = 26, ROW = 17, B = 24;
  const H = T + BARS + GAP + ROW * MODELS.length + B;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", "Lluvia por horas según cada modelo");

  const cw = (W - L - R) / 24; // ancho de cada franja horaria
  const x = (k) => L + k * cw;
  const maxVal = Math.max(0, ...slots.map((s) => s.max ?? 0));
  const top = [1, 2, 5, 10, 20, 50].find((v) => v >= maxVal) || Math.ceil(maxVal); // escala "redonda"
  const y = (mm) => T + BARS - (mm / top) * BARS;
  const rgba = (c) => `rgba(${c.join(",")})`;
  const tip = (k) => `${k}–${k + 1} h`;

  let g = "";
  // Rejilla y eje de mm.
  for (const v of [0, top / 2, top]) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, v % 1 ? 1 : 0)} mm</text>`;
  }
  // Barras de la mediana y raya del rango entre modelos.
  slots.forEach((s, k) => {
    if (!s.n) return;
    const cx = x(k) + cw / 2;
    if (s.median >= 0.05) {
      const color = rainColor(s.median);
      const fill = color ? rgba([...color.slice(0, 3), 0.9]) : "var(--accent)";
      g += `<rect x="${x(k) + 2}" y="${y(s.median)}" width="${cw - 4}" height="${y(0) - y(s.median)}" rx="2" fill="${fill}">` +
        `<title>${tip(k)}: ${fmt(s.median, 1)} mm (mediana)</title></rect>`;
    }
    if (s.max >= 0.1) {
      g += `<line x1="${cx}" x2="${cx}" y1="${y(s.max)}" y2="${y(s.min)}" stroke="var(--ink)" stroke-width="1.5" stroke-opacity=".6"/>`;
    }
  });

  // Una fila por modelo: cada hora coloreada según los mm.
  const rowsTop = T + BARS + GAP;
  MODELS.forEach((m, r) => {
    const yy = rowsTop + r * ROW;
    g += `<text x="${L - 6}" y="${yy + ROW / 2 + 4}" text-anchor="end">${m.name}</text>`;
    if (!rows[r].some(isNum)) {
      g += `<text x="${(L + W - R) / 2}" y="${yy + ROW / 2 + 4}" text-anchor="middle">sin datos (no llega a este día)</text>`;
      return;
    }
    rows[r].forEach((v, k) => {
      const color = isNum(v) ? rainColor(v) : null;
      const fill = color ? rgba(color) : "var(--line)";
      const opacity = v == null ? 0.12 : color ? 1 : 0.35; // sin datos, seco o con lluvia
      const label = v == null ? "sin datos" : `${fmt(v, 1)} mm`;
      g += `<rect x="${x(k) + 1}" y="${yy + 1}" width="${cw - 2}" height="${ROW - 3}" rx="2" fill="${fill}" fill-opacity="${opacity}">` +
        `<title>${m.name} · ${tip(k)}: ${label}</title></rect>`;
    });
  });

  // Horas en el eje inferior (en los bordes de las franjas).
  for (let k = 0; k <= 24; k += 3) {
    g += `<text x="${x(k)}" y="${H - 6}" text-anchor="middle">${k}h</text>`;
  }
  if (maxVal < 0.1) {
    g += `<text x="${(L + W - R) / 2}" y="${T + BARS / 2}" text-anchor="middle">Ningún modelo da lluvia este día</text>`;
  }
  svg.innerHTML = g;

  $("legend").innerHTML = RAIN_SCALE.map(({ mm, rgba: c }) =>
    `<span><i class="sq" style="background:${rgba(c)}"></i>${fmt(mm, mm < 1 ? 1 : 0)}</span>`
  ).join("") + "<span>mm en la hora</span>";
}

function render() {
  renderHeadline();
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

// Pestañas del gráfico: temperatura o lluvia.
$("chart-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  state.chart = tab.dataset.c;
  $("chart-tabs").querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  renderChart();
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
