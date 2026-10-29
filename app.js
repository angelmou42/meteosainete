/* Meteosainete — módulo principal
 *
 * Flujo: load() pide la predicción de 6 modelos a Open-Meteo → normaliza los
 * datos en `state.data` → render() pinta la franja de consenso, la matriz
 * y el gráfico horario. Las utilidades y el cálculo del consenso están en
 * core.js; los gráficos en charts.js; los mapas de lluvia en map.js; la
 * pestaña de acierto en acierto.js; el buscador en places.js.
 */
import { $, MODELS, consensus, dayAlerts, daySummary, dropPastDays, localDate, dayName, estimateProb, fetchJson, fmt, formatPeriods, hourlyRain, isNight, isNum,
  publishesProb, rainLabel, rainPeriods, rainSlots, skyIcon, state, tempAt } from "./core.js";
import { ICON_LABELS, iconSvg } from "./icons.js";
import { initCharts, renderChart } from "./charts.js";
import { initPlaces, notePlace } from "./places.js";
import { initMaps, setMapTheme, updateMaps } from "./map.js";
import { initAccuracy, loadResults, rainChanceFor, showAccuracy } from "./acierto.js";

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
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,weather_code,sunrise,sunset",
    hourly: "temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m",
    models: MODELS.map((m) => m.id).join(","),
  });
  const j = await fetchJson("https://api.open-meteo.com/v1/forecast?" + params);
  if (!j.daily || !j.hourly) throw new Error("Respuesta inesperada de la API");

  const days = j.daily.time.length;
  // Si una variable no viene, la rellenamos con null para no romper el render.
  const pick = (block, name, len, id) => j[block][`${name}_${id}`] || Array(len).fill(null);

  // offset: desfase horario de la ciudad (segundos), para saber qué hora es allí.
  const out = { dates: j.daily.time, offset: j.utc_offset_seconds, m: {} };
  // Salida y puesta de sol: son iguales en todos los modelos, vale el primero que las traiga.
  const sunKey = (name) => Object.keys(j.daily).find((k) => k.startsWith(name + "_"));
  out.sun = { rise: j.daily[sunKey("sunrise")] || [], set: j.daily[sunKey("sunset")] || [] };
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
      hcode: pick("hourly", "weather_code", hours, id),   // código WMO del tiempo (para tormenta, nieve y niebla)
      hcloud: pick("hourly", "cloud_cover", hours, id),   // nubosidad en %
      hwind: pick("hourly", "wind_speed_10m", hours, id), // viento medio en km/h
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
    const icon = skyIcon(state.data, i);
    // Horas de lluvia del día (por ejemplo "15–19 h"), cuando más de la mitad de los modelos la dan.
    const when = formatPeriods(rainPeriods(rainSlots(hourlyRain(state.data, i))), true);
    // El total diario de Open-Meteo va de 23 a 23 h y las franjas de 0 a 24 h: si la lluvia cae
    // justo al final del día, el total puede salir 0 aunque haya horas de lluvia.
    const rainy = c.rain >= 0.1 || when || c.wet > 0;
    // Días secos: solo "Seco". Días con lluvia: probabilidad, mm, horas y cuántos modelos la dan.
    const rainHtml = rainy
      ? `<span class="rain">${isNum(c.prob) ? `<b class="pct">${fmt(c.prob)} %</b> · ` : ""}` +
        `${c.rain >= 0.1 ? `${fmt(c.rain, 1)} mm ${rainLabel(c.rain)}` : "algo de lluvia"}` +
        `${when ? ` · <span class="when">${when}</span>` : ""}` +
        `<br><span class="agree">Lo dan ${c.wet} de ${c.n} modelos</span></span>`
      : `<span class="rain dry">Seco${isNum(c.prob) && c.prob >= 10 ? ` · ${fmt(c.prob)} %` : ""}</span>`;

    const b = document.createElement("button");
    b.type = "button";
    b.className = "day";
    b.setAttribute("aria-pressed", String(i === state.sel));
    b.innerHTML = `
      <span class="dname">${dayName(iso, i)}</span>
      <span class="day-main">${iconSvg(icon, 40)}<span class="temps">${fmt(c.tmax)}°<small> / ${fmt(c.tmin)}°</small></span></span>
      ${rainHtml}
      ${alertsHtml(c)}
      <span class="rel c-${c.level}" title="Fiabilidad ${c.level}: cuánto coinciden los modelos"><i></i><span class="rel-word">Fiabilidad </span>${c.level}</span>`;
    b.addEventListener("click", () => { state.sel = i; render(); });
    el.appendChild(b);
  });
  $("strip-title").textContent = `Consenso de ${MODELS.length} modelos`;
}

// Hora actual (0–23) en la zona horaria de la ciudad.
function localHour() {
  return new Date(Date.now() + (state.data.offset || 0) * 1000).getUTCHours();
}

/* Bloque "Ahora": temperatura y cielo de la hora actual según el consenso, y
 * la frase de lo que queda de hoy. Siempre muestra hoy, sea cual sea el día elegido. */
function renderNow() {
  const d = state.data, h = localHour();
  const night = isNight(d, 0, h);
  // Para el icono de "ahora" se mira la hora en curso: lluvia en la franja h y cielo en la marca h.
  const icon = skyIcon(d, 0, { rainFrom: h, rainTo: h + 1, skyFrom: h, skyTo: h + 1, night });
  const c = consensus(d, 0);
  const { text, tone } = daySummary(d, 0, h);
  $("now").innerHTML = `
    <div class="now-main">
      ${iconSvg(icon, 76)}
      <div>
        <div class="now-temp">${fmt(tempAt(d, 0, h))}°</div>
        <div class="now-cond">${ICON_LABELS[icon]} · ahora</div>
      </div>
    </div>
    <div class="now-side">
      <p class="now-summary t-${tone}">${text} ${chanceText(c, 0)}</p>
      ${alertsHtml(c)}
      <p class="now-facts">
        <span>Hoy <b>${fmt(c.tmax)}°</b> / ${fmt(c.tmin)}°</span>
        <span>Viento hasta <b>${fmt(c.wind)}</b> km/h</span>
        <span class="rel c-${c.level}"><i></i>Fiabilidad ${c.level}</span>
        ${sunTimes(d)}
      </p>
    </div>
    <div class="hours" aria-label="Próximas 12 horas">${nextHours(d, h)}</div>`;
}

// Etiquetas de aviso (heladas, calor, viento, lluvia fuerte) calculadas con el consenso.
function alertsHtml(c) {
  const alerts = dayAlerts(c);
  return alerts.length
    ? `<span class="alerts">${alerts.map((a) => `<span class="alert a-${a.id}" title="Según el consenso de los modelos (no es un aviso oficial): ${a.why}">${a.label}</span>`).join("")}</span>`
    : "";
}

// "Amanece 07:39 · Anochece 18:19" (hoy).
function sunTimes(d) {
  const t = (iso) => iso?.slice(11, 16);
  const rise = t(d.sun?.rise?.[0]), set = t(d.sun?.set?.[0]);
  return rise && set ? `<span>Amanece ${rise} · anochece ${set}</span>` : "";
}

/* Próximas 12 horas: hora, icono, temperatura y lluvia (si la hay) según el
 * consenso. Pasada la medianoche sigue con los datos de mañana. */
function nextHours(d, h) {
  let html = "";
  for (let k = 0; k < 12; k++) {
    const i = Math.floor((h + k) / 24), hh = (h + k) % 24;
    if (i >= d.dates.length) break;
    const icon = skyIcon(d, i, { rainFrom: hh, rainTo: hh + 1, skyFrom: hh, skyTo: hh + 1, night: isNight(d, i, hh) });
    const rain = rainSlots(hourlyRain(d, i))[hh].median;
    html += `<div class="hour${k === 0 ? " is-now" : ""}">
      <span class="h-time">${k === 0 ? "Ahora" : `${String(hh).padStart(2, "0")}h`}</span>
      ${iconSvg(icon, 30)}
      <b>${fmt(tempAt(d, i, hh))}°</b>
      <span class="h-rain">${rain >= 0.1 ? `${fmt(rain, 1)} mm` : ""}</span>
    </div>`;
  }
  return html;
}

/* Frase extra con lo que dice el estudio de acierto: cuando X de N modelos dan
 * lluvia, cuántas veces llovió de verdad en la zona. Hoy y mañana usan la tabla
 * de 1 día de antelación; los días siguientes, la de 3 días. */
function chanceText(c, i) {
  if (!c.wet || !c.n) return "";
  const r = rainChanceFor(state.place, i <= 1 ? 1 : 3, c.wet, c.n);
  if (!r) return "";
  return `<span class="chance">Días como este (${c.wet} de ${c.n} modelos con 1 mm o más) acabaron con lluvia ` +
    `el ${fmt(r.pct)} % de las veces ${r.zone ? "en esta zona" : "en España"}.</span>`;
}

// Frase resumen del día elegido (para hoy ya está en el bloque "Ahora").
function renderHeadline() {
  const i = state.sel, el = $("headline");
  el.hidden = i === 0;
  if (i === 0) return;
  const { text, tone } = daySummary(state.data, i, 0);
  el.className = `headline t-${tone}`;
  el.innerHTML = `<b>${dayName(state.data.dates[i], i)}:</b> ${text} ${chanceText(consensus(state.data, i), i)}`;
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
      return `<td style="background:${tempBg(o.tmax[i])}">${o.icon ? iconSvg(o.icon[i], 22) : ""}${fmt(o.tmax[i])}°<span class="na"> / ${fmt(o.tmin[i])}°</span></td>`;
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
    // Icono de cada día según ese modelo solo (skyIcon con un único modelo): así se ve si discrepan.
    if (state.view === "temp") o.icon = d.dates.map((_, i) => skyIcon({ m: { [m.id]: d.m[m.id] }, sun: d.sun }, i));
    if (o.estimable && o.rain.some(isNum)) estimated = true;
    html += `<tr><th><div class="mname"><i style="background:var(${m.c})"></i>${m.name}</div><div class="morigin">${m.origin}</div></th>${d.dates.map((_, i) => cell(o, i)).join("")}</tr>`;
  }

  // Fila de consenso: misma forma que un modelo para reutilizar cell().
  const cons = { tmax: [], tmin: [], rain: [], prob: [], wind: [], estimable: false };
  if (state.view === "temp") cons.icon = d.dates.map((_, i) => skyIcon(d, i));
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

function render() {
  renderNow();
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

/* ---------- Última predicción guardada (para usar sin conexión) ----------
 * Se guarda la última predicción descargada. Si la red falla para ese mismo
 * sitio, se muestra con un aviso de cuándo se descargó: son datos reales,
 * pero viejos, y la web lo dice claramente. */
const LAST_KEY = "meteosainete:ultima";

function saveLast(place, data) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ place, data, savedAt: Date.now() })); } catch { /* lleno o bloqueado */ }
}

function readLast(place) {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY));
    const same = last && Math.abs(last.place.lat - place.lat) < 0.01 && Math.abs(last.place.lon - place.lon) < 0.01;
    return same ? last : null;
  } catch {
    return null;
  }
}

async function load(place) {
  state.place = place;
  $("place").textContent = place.label;
  placeToUrl(place);
  updateMaps(); // los mapas no dependen de esta petición: se actualizan aunque falle
  if (state.page === "accuracy") showAccuracy(); // el aviso de zona depende de la ciudad
  showStatus("loading");
  $("stale").hidden = true;
  try {
    state.data = await fetchForecast(place.lat, place.lon);
    saveLast(place, state.data);
  } catch (err) {
    console.error(err);
    const last = readLast(place);
    if (!last) {
      showStatus("error", errorMessage(err));
      return;
    }
    // Si se guardó otro día, se quitan los días que ya han pasado para que "Hoy" sea hoy.
    const today = last.data.dates.indexOf(localDate(last.data.offset));
    if (today < 0 && last.data.dates[last.data.dates.length - 1] < localDate(last.data.offset)) {
      showStatus("error", errorMessage(err) + " La última predicción guardada es demasiado antigua.");
      return;
    }
    state.data = dropPastDays(last.data, Math.max(0, today));
    const when = new Date(last.savedAt).toLocaleString("es-ES", { weekday: "long", hour: "2-digit", minute: "2-digit" });
    $("stale-msg").textContent = `${errorMessage(err)} Mientras tanto ves la predicción guardada el ${when}.`;
    $("stale").hidden = false;
  }
  state.sel = 0;
  savePlace(place);
  notePlace(place); // recientes y estrella de favorita
  showStatus("content");
  render();
  // Los resultados del estudio llegan después (no hacen falta para ver el tiempo): al llegar,
  // se repintan las frases con "en esta zona llueve el X % de las veces".
  loadResults().then(() => { if (state.place === place) { renderNow(); renderHeadline(); } }).catch(() => {});
}

/* ---------- Eventos ---------- */

$("retry").addEventListener("click", () => load(state.place));
$("stale-retry").addEventListener("click", () => load(state.place));

// Service worker: hace la web instalable y permite abrirla sin conexión (ver sw.js).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Sin service worker:", err));
}

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

/* Compartir: en el móvil abre el menú de compartir del sistema; en el
 * ordenador copia el enlace (que ya lleva la ciudad en la URL). */
$("share").addEventListener("click", async () => {
  const url = location.href;
  const title = `El tiempo en ${state.place?.label.split(",")[0] || "tu ciudad"} · Meteosainete`;
  try {
    if (navigator.share) return await navigator.share({ title, url });
    await navigator.clipboard.writeText(url);
    showToast("Enlace copiado");
  } catch (err) {
    if (err.name !== "AbortError") showToast("No se ha podido compartir");
  }
});

function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

/* ---------- Tema claro / oscuro ----------
 * Por defecto sigue al sistema. El botón alterna y guarda la elección. */
const THEME_KEY = "meteosainete:tema";
const darkNow = () => document.documentElement.dataset.theme === "dark" ||
  (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);

function renderThemeButton() {
  const dark = darkNow();
  const btn = $("theme");
  const label = dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  // Sol en modo oscuro (para pasar a claro) y luna en modo claro.
  btn.innerHTML = dark
    ? `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`
    : `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>`;
}

$("theme").addEventListener("click", () => {
  const next = darkNow() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* sin almacenamiento: solo dura esta visita */ }
  renderThemeButton();
  setMapTheme(); // el mapa base también cambia de tema
  if (state.data) renderChart(); // el gráfico usa colores calculados al dibujarse
});

/* Pestañas con teclado: ← → (y Inicio / Fin) mueven entre las pestañas de un
 * mismo grupo, como en el patrón de pestañas accesibles de WAI-ARIA. */
document.addEventListener("keydown", (e) => {
  const tab = e.target.closest?.('[role="tab"]');
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
  const k = tabs.indexOf(tab);
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (k + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});

// Arranque: ciudad de la URL (enlace compartido), si no la última guardada, si no Arjona.
renderThemeButton();
initCharts();
initMaps();
initAccuracy();
initPlaces({ onSelect: load });
state.page = pageFromHash();
load(placeFromUrl() || readSavedPlace() || DEFAULT_PLACE);
showPage(state.page);
