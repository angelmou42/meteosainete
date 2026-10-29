/* Meteosainete — gráficos horarios del día elegido
 *
 * Temperatura y viento (líneas por modelo, banda del rango y mediana) y lluvia
 * (barras de la mediana y una fila por modelo). Se dibujan en SVG al ancho real
 * de su caja y son interactivos: al pasar el ratón o el dedo aparece una línea
 * vertical y una ficha con el valor de cada modelo.
 *
 * app.js usa initCharts() y renderChart(); linePath se exporta para los tests.
 */
import { $, MODELS, RAIN_SCALE, dayName, fmt, hourlyRain, isNum, median, nums, rainColor, rainSlots, state } from "./core.js";

// Convierte puntos en un trazado SVG, cortando la línea donde falten datos.
export function linePath(points) {
  let d = "", pen = false;
  for (const p of points) {
    if (!p) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

// Gráfico del día seleccionado: temperatura o lluvia según la pestaña.
export function renderChart() {
  hideChartTip();
  const name = dayName(state.data.dates[state.sel], state.sel).toLowerCase();
  const kind = state.chart;
  $("chart-title").textContent = `${{ temp: "Temperatura", rain: "Lluvia", wind: "Viento" }[kind]} hora a hora · ${name}`;
  $("chart-note").textContent = kind === "rain"
    ? "Barras: mediana de los modelos (la raya va del que menos al que más da). Debajo, la lluvia de cada modelo hora a hora."
    : "La banda gris es el rango entre modelos; la línea discontinua, la mediana.";
  if (kind === "rain") renderRainChart();
  else if (kind === "wind") renderLineChart(WIND_CHART);
  else renderLineChart(TEMP_CHART);
}

// Gráficos de líneas: qué dato usan y cómo se dibuja su escala.
const TEMP_CHART = { key: "hourly", unit: "°", decimals: 1, step: 2, minSpan: 6, zero: false, label: "Temperatura por horas según cada modelo" };
const WIND_CHART = { key: "hwind", unit: " km/h", decimals: 0, step: 10, minSpan: 20, zero: true, label: "Viento por horas según cada modelo" };

/* ---------- Gráficos interactivos ----------
 * Los gráficos se dibujan al ancho real de su caja (no se escalan), así el
 * texto se lee igual en el móvil que en el ordenador. Al pasar el ratón o el
 * dedo aparece una línea vertical y una ficha con el valor de cada modelo. */

// Lo que necesita el puntero para saber qué hora está señalando y qué mostrar.
let chartHover = null; // { hit(px) → índice | null, lineX(k), info(k) → html, top, bottom }

function chartWidth() {
  const box = $("chart").parentElement;
  return Math.max(280, Math.round(box.clientWidth - 24)); // 24 = relleno de .chartbox
}

function sizeSvg(svg, W, H, label) {
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("aria-label", label);
}

// Línea vertical que sigue al puntero (al final del SVG para que quede encima).
const CROSS = `<line id="chart-cross" y1="0" y2="0" stroke="var(--ink)" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`;

// Filas de la ficha: punto de color, nombre del modelo y valor.
function tipRows(values, unit, decimals) {
  return MODELS.map((m, r) => `<div><i style="background:var(${m.c})"></i>${m.name}<b>${isNum(values[r]) ? fmt(values[r], decimals) + unit : "—"}</b></div>`).join("") +
    `<div class="tip-med"><i style="background:var(--ink)"></i>Mediana<b>${isNum(median(values)) ? fmt(median(values), decimals) + unit : "—"}</b></div>`;
}

function renderLineChart(cfg) {
  const svg = $("chart");
  const d = state.data;
  const i = state.sel;
  const W = chartWidth(), compact = W < 480;
  const H = compact ? 220 : 260, L = 34, R = 10, T = 14, B = 26; // tamaño y márgenes
  sizeSvg(svg, W, H, cfg.label);

  $("legend").innerHTML = MODELS.map((m) => `<span><i style="background:var(${m.c})"></i>${m.name}</span>`).join("")
    + `<span><i style="background:var(--ink)"></i>Mediana</span>`;

  // 24 valores horarios del día seleccionado para cada modelo.
  const series = MODELS.map((m) => ({ m, v: (d.m[m.id][cfg.key] || []).slice(i * 24, i * 24 + 24) }));
  const all = series.flatMap((s) => nums(s.v));
  if (!all.length) {
    chartHover = null;
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Sin datos horarios para este día</text>`;
    return;
  }

  // Escala vertical redondeada a múltiplos de `step` (2 °C, 10 km/h…), con un alto mínimo.
  const st = cfg.step;
  let lo = Math.floor(Math.min(...all) / st) * st;
  let hi = Math.ceil(Math.max(...all) / st) * st;
  if (hi - lo < cfg.minSpan) { hi += st; lo -= st; }
  if (cfg.zero) lo = Math.max(0, lo); // el viento no baja de 0
  const step = (W - L - R) / 23;
  const x = (h) => L + h * step;
  const y = (t) => T + ((hi - t) * (H - T - B)) / (hi - lo);

  let g = "";
  for (let t = lo; t <= hi; t += (hi - lo) / st > 6 && compact ? 2 * st : st) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/>`;
    g += `<text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}${cfg.unit === "°" ? "°" : ""}</text>`;
  }
  for (let h = 0; h < 24; h += compact ? 6 : 3) {
    g += `<text x="${x(h)}" y="${H - 8}" text-anchor="middle">${String(h).padStart(2, "0")}h</text>`;
  }
  if (cfg.unit !== "°") g += `<text x="${L + 4}" y="${T + 10}">${cfg.unit.trim()}</text>`; // unidad del eje

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
  svg.innerHTML = g + CROSS;

  chartHover = {
    top: T, bottom: H - B,
    hit: (px) => (px < L - step / 2 || px > W - R + step / 2 ? null : Math.max(0, Math.min(23, Math.round((px - L) / step)))),
    lineX: x,
    info: (h) => `<div class="tip-head">${String(h).padStart(2, "0")}:00</div>` + tipRows(series.map((s) => s.v[h]), cfg.unit, cfg.decimals),
  };
}

/* Lluvia por horas: arriba, barras con la mediana de los modelos y una raya
 * del mínimo al máximo; debajo, una fila por modelo con cada hora coloreada
 * según los mm (como un mapa de calor), para ver si coinciden en el "cuándo". */
function renderRainChart() {
  const svg = $("chart");
  const rows = hourlyRain(state.data, state.sel);
  const slots = rainSlots(rows);
  const W = chartWidth(), compact = W < 480;
  const L = compact ? 78 : 92, R = 10, T = 14, BARS = compact ? 90 : 110, GAP = 22, ROW = compact ? 15 : 17, B = 22;
  const H = T + BARS + GAP + ROW * MODELS.length + B;
  sizeSvg(svg, W, H, "Lluvia por horas según cada modelo");

  const cw = (W - L - R) / 24; // ancho de cada franja horaria
  const x = (k) => L + k * cw;
  const maxVal = Math.max(0, ...slots.map((s) => s.max ?? 0));
  const top = [1, 2, 5, 10, 20, 50].find((v) => v >= maxVal) || Math.ceil(maxVal); // escala "redonda"
  const y = (mm) => T + BARS - (mm / top) * BARS;
  const rgba = (c) => `rgba(${c.join(",")})`;
  const gap = cw > 10 ? 2 : 1;

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
      g += `<rect x="${x(k) + gap}" y="${y(s.median)}" width="${cw - 2 * gap}" height="${y(0) - y(s.median)}" rx="2" fill="${fill}"/>`;
    }
    if (s.max >= 0.1) {
      g += `<line x1="${cx}" x2="${cx}" y1="${y(s.max)}" y2="${y(s.min)}" stroke="var(--ink)" stroke-width="1.5" stroke-opacity=".6"/>`;
    }
  });

  // Una fila por modelo: cada hora coloreada según los mm.
  const rowsTop = T + BARS + GAP;
  MODELS.forEach((m, r) => {
    const yy = rowsTop + r * ROW;
    g += `<text x="${L - 6}" y="${yy + ROW / 2 + 4}" text-anchor="end">${compact ? m.short || m.name : m.name}</text>`;
    if (!rows[r].some(isNum)) {
      g += `<text x="${(L + W - R) / 2}" y="${yy + ROW / 2 + 4}" text-anchor="middle">sin datos (no llega a este día)</text>`;
      return;
    }
    rows[r].forEach((v, k) => {
      const color = isNum(v) ? rainColor(v) : null;
      const fill = color ? rgba(color) : "var(--line)";
      const opacity = v == null ? 0.12 : color ? 1 : 0.35; // sin datos, seco o con lluvia
      g += `<rect x="${x(k) + gap / 2}" y="${yy + 1}" width="${cw - gap}" height="${ROW - 3}" rx="2" fill="${fill}" fill-opacity="${opacity}"/>`;
    });
  });

  // Horas en el eje inferior (en los bordes de las franjas).
  for (let k = 0; k <= 24; k += compact ? 6 : 3) {
    g += `<text x="${x(k)}" y="${H - 6}" text-anchor="middle">${k}h</text>`;
  }
  if (maxVal < 0.1) {
    g += `<text x="${(L + W - R) / 2}" y="${T + BARS / 2}" text-anchor="middle">Ningún modelo da lluvia este día</text>`;
  }
  svg.innerHTML = g + CROSS;

  chartHover = {
    top: T, bottom: H - B,
    hit: (px) => (px < L || px > W - R ? null : Math.min(23, Math.floor((px - L) / cw))),
    lineX: (k) => x(k) + cw / 2,
    info: (k) => `<div class="tip-head">${k}–${k + 1} h</div>` + tipRows(rows.map((r) => r[k]), " mm", 1),
  };

  $("legend").innerHTML = RAIN_SCALE.map(({ mm, rgba: c }) =>
    `<span><i class="sq" style="background:${rgba(c)}"></i>${fmt(mm, mm < 1 ? 1 : 0)}</span>`
  ).join("") + "<span>mm en la hora</span>";
}

// Mueve la línea y la ficha a la hora que señala el puntero (ratón o dedo).
function showChartTip(e) {
  const svg = $("chart"), tip = $("chart-tip"), cross = $("chart-cross");
  if (!chartHover || !cross) return;
  const rect = svg.getBoundingClientRect();
  const k = chartHover.hit(e.clientX - rect.left);
  if (k == null) return hideChartTip();
  const lx = chartHover.lineX(k);
  cross.setAttribute("x1", lx);
  cross.setAttribute("x2", lx);
  cross.setAttribute("y1", chartHover.top);
  cross.setAttribute("y2", chartHover.bottom);
  cross.setAttribute("visibility", "visible");
  tip.innerHTML = chartHover.info(k);
  tip.hidden = false;
  // La ficha va a la derecha de la línea, o a la izquierda si no cabe.
  const boxLeft = rect.left - svg.parentElement.getBoundingClientRect().left; // los SVG no tienen offsetLeft
  const right = boxLeft + lx + 14;
  tip.style.left = (right + tip.offsetWidth > svg.parentElement.clientWidth ? boxLeft + lx - 14 - tip.offsetWidth : right) + "px";
}

function hideChartTip() {
  $("chart-tip").hidden = true;
  $("chart-cross")?.setAttribute("visibility", "hidden");
}

/* Pestañas del gráfico, puntero y redibujado al cambiar el ancho.
 * Se llama una vez desde app.js. */
export function initCharts() {
  // Pestañas del gráfico: temperatura o lluvia.
  $("chart-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    state.chart = tab.dataset.c;
    $("chart-tabs").querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    renderChart();
  });

  // Ficha del gráfico: sigue al ratón o al dedo y se oculta al salir.
  $("chart").addEventListener("pointermove", showChartTip);
  $("chart").addEventListener("pointerdown", showChartTip);
  $("chart").addEventListener("pointerleave", hideChartTip);

  // Los gráficos se dibujan al ancho de su caja: si cambia (girar el móvil, redimensionar), se redibujan.
  let lastChartWidth = 0;
  new ResizeObserver(() => {
    const w = $("chart").parentElement.clientWidth;
    if (!state.data || !w || w === lastChartWidth) return;
    lastChartWidth = w;
    hideChartTip();
    renderChart();
  }).observe($("chart").parentElement);
}
