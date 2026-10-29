/* Meteosainete — buscador y ciudades guardadas
 *
 * - Sugerencias mientras se escribe (geocodificador de Open-Meteo), con
 *   teclado: ↑ ↓ para moverse, Intro para elegir, Esc para cerrar.
 * - Ciudades recientes (las 5 últimas) y favoritas (★), como accesos rápidos
 *   debajo de la cabecera. Se guardan en localStorage.
 *
 * app.js usa initPlaces() y notePlace(); el resto se exporta para los tests.
 */
import { $, fetchJson, state } from "./core.js";

const RECENT_KEY = "meteosainete:recientes";
const FAV_KEY = "meteosainete:favoritas";
const MAX_RECENT = 5;
const MAX_FAV = 8;
const DEBOUNCE_MS = 300;

/* ---------- Listas de ciudades (funciones puras) ---------- */

// Dos sitios son el mismo si están a menos de ~1 km (0,01°).
export const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;

// Pone el sitio el primero de la lista, sin repetirlo, y recorta al máximo.
export function pushRecent(list, place, max = MAX_RECENT) {
  return [place, ...list.filter((p) => !samePlace(p, place))].slice(0, max);
}

// Añade el sitio a favoritas o lo quita si ya estaba.
export function toggleFavorite(list, place, max = MAX_FAV) {
  return list.some((p) => samePlace(p, place)) ? list.filter((p) => !samePlace(p, place)) : [...list, place].slice(-max);
}

// "Arjona, Andalucía, España" a partir de un resultado del geocodificador.
export const placeLabel = (r) => [r.name, r.admin1, r.country].filter(Boolean).join(", ");

/* ---------- localStorage (con try/catch: puede estar bloqueado) ---------- */

function readList(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key));
    return Array.isArray(list) ? list.filter((p) => p && typeof p.lat === "number" && typeof p.lon === "number" && typeof p.label === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* sin almacenamiento: no pasa nada */ }
}

/* ---------- Accesos rápidos y estrella ---------- */

let onSelectPlace = () => {};

// Botones de favoritas (★) y recientes debajo de la cabecera. La ciudad actual no se repite.
function renderChips() {
  const favs = readList(FAV_KEY);
  const recents = readList(RECENT_KEY).filter((p) => !favs.some((f) => samePlace(f, p)));
  const current = state.place;
  const box = $("chips");
  box.innerHTML = "";
  for (const [p, fav] of [...favs.map((p) => [p, true]), ...recents.map((p) => [p, false])]) {
    if (current && samePlace(p, current)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-place" + (fav ? " is-fav" : "");
    b.textContent = (fav ? "★ " : "") + p.label.split(",")[0]; // solo el nombre: la etiqueta entera ocupa mucho
    b.title = p.label;
    b.addEventListener("click", () => onSelectPlace(p));
    box.appendChild(b);
  }
}

function renderStar() {
  const on = !!state.place && readList(FAV_KEY).some((p) => samePlace(p, state.place));
  const star = $("fav");
  star.textContent = on ? "★" : "☆";
  star.setAttribute("aria-pressed", String(on));
  star.title = on ? "Quitar de favoritas" : "Añadir a favoritas";
}

// Se llama cada vez que se carga una ciudad: la apunta en recientes y actualiza la estrella.
export function notePlace(place) {
  writeList(RECENT_KEY, pushRecent(readList(RECENT_KEY), place));
  renderChips();
  renderStar();
}

/* ---------- Sugerencias mientras se escribe ---------- */

let suggestions = [];  // resultados mostrados
let active = -1;       // índice resaltado con el teclado
let request = 0;       // para descartar respuestas de búsquedas antiguas
let timer = null;

async function search(q) {
  const id = ++request;
  let j;
  try {
    j = await fetchJson("https://geocoding-api.open-meteo.com/v1/search?" + new URLSearchParams({ name: q, count: 6, language: "es" }));
  } catch {
    if (id === request) showMessage("No se ha podido buscar: revisa la conexión.");
    return [];
  }
  return id === request ? (j.results || []) : null; // null = respuesta antigua, se ignora
}

function showMessage(text) {
  $("results").textContent = text;
}

function renderSuggestions() {
  const list = $("suggest");
  list.innerHTML = suggestions.map((r, k) =>
    `<li role="option" id="sug-${k}" aria-selected="${k === active}" data-k="${k}">` +
    `<b>${escapeHtml(r.name)}</b> <span>${escapeHtml([r.admin1, r.country].filter(Boolean).join(", "))}</span></li>`
  ).join("");
  const open = suggestions.length > 0;
  list.hidden = !open;
  $("q").setAttribute("aria-expanded", String(open));
  $("q").setAttribute("aria-activedescendant", active >= 0 ? `sug-${active}` : "");
}

function closeSuggestions() {
  suggestions = [];
  active = -1;
  renderSuggestions();
}

function choose(r) {
  closeSuggestions();
  $("q").value = "";
  showMessage("");
  onSelectPlace({ lat: r.latitude, lon: r.longitude, label: placeLabel(r) });
}

// Los nombres vienen de una API: se escapan antes de meterlos en HTML.
function escapeHtml(text = "") {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Arranque ---------- */

// onSelect(place): qué hacer al elegir una ciudad (en app.js, cargarla).
export function initPlaces({ onSelect }) {
  onSelectPlace = onSelect;
  const input = $("q");

  input.addEventListener("input", () => {
    clearTimeout(timer);
    showMessage("");
    const q = input.value.trim();
    if (q.length < 2) return closeSuggestions();
    // Espera a que se deje de escribir un momento para no lanzar una petición por tecla.
    timer = setTimeout(async () => {
      const results = await search(q);
      if (results === null) return;
      suggestions = results;
      active = -1;
      renderSuggestions();
      if (!results.length) showMessage("No encuentro esa ciudad. Prueba con otro nombre.");
    }, DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (e) => {
    if (!suggestions.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = suggestions.length;
      active = (active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderSuggestions();
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });

  // Intro o botón "Buscar": la sugerencia resaltada o, si no hay, la primera.
  $("search").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return;
    if (suggestions.length) return choose(suggestions[Math.max(active, 0)]);
    const results = await search(q);
    if (results?.length) choose(results[0]);
    else if (results) showMessage("No encuentro esa ciudad. Prueba con otro nombre.");
  });

  // mousedown (y no click) para elegir antes de que el campo pierda el foco y se cierre la lista.
  $("suggest").addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    e.preventDefault();
    choose(suggestions[Number(li.dataset.k)]);
  });
  input.addEventListener("blur", () => setTimeout(closeSuggestions, 150));

  $("fav").addEventListener("click", () => {
    if (!state.place) return;
    writeList(FAV_KEY, toggleFavorite(readList(FAV_KEY), state.place));
    renderStar();
    renderChips();
  });

  renderChips();
}
