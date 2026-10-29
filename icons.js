/* Meteosainete — iconos del tiempo
 *
 * SVG propios, sin librerías. Usan variables CSS (--sun, --cloud, --drop…)
 * para adaptarse al modo claro y oscuro. iconSvg(clave) devuelve el código
 * SVG listo para insertar; las claves salen de skyIcon() en core.js.
 */

// Piezas reutilizables (coordenadas en una caja de 64 × 64).
const SUN = `<circle cx="32" cy="32" r="11" fill="var(--sun)"/>
  <g stroke="var(--sun)" stroke-width="4" stroke-linecap="round">
    <path d="M32 8v6M32 50v6M8 32h6M50 32h6M15 15l4 4M45 45l4 4M15 49l4-4M45 19l4-4"/>
  </g>`;
const SMALL_SUN = `<circle cx="22" cy="22" r="9" fill="var(--sun)"/>
  <g stroke="var(--sun)" stroke-width="3.5" stroke-linecap="round">
    <path d="M22 4v5M4 22h5M9 9l3.5 3.5M35 9l-3.5 3.5M9 35l3.5-3.5"/>
  </g>`;
const MOON = `<path d="M40 10a20 20 0 1 0 14 30A16 16 0 0 1 40 10z" fill="var(--moon)"/>`;
const SMALL_MOON = `<path d="M26 6a14 14 0 1 0 10 21A11 11 0 0 1 26 6z" fill="var(--moon)"/>`;
const CLOUD = (y = 0, fill = "var(--cloud)") =>
  `<path transform="translate(0 ${y})" d="M18 46h30a10 10 0 0 0 0-20 14 14 0 0 0-27-3A11 11 0 0 0 18 46z" fill="${fill}"/>`;
const DROPS = (n = 3) => {
  const xs = n === 2 ? [26, 38] : [22, 32, 42];
  return xs.map((x) => `<path d="M${x} 50l-3 8" stroke="var(--drop)" stroke-width="3.5" stroke-linecap="round"/>`).join("");
};

const ICONS = {
  clear: SUN,
  "clear-night": MOON,
  partly: SMALL_SUN + CLOUD(4),
  "partly-night": SMALL_MOON + CLOUD(4),
  cloudy: CLOUD(-4, "var(--cloud-dark)") + CLOUD(4),
  fog: CLOUD(-6) + `<g stroke="var(--cloud-dark)" stroke-width="3.5" stroke-linecap="round"><path d="M14 48h36M20 56h28"/></g>`,
  drizzle: CLOUD(-6) + DROPS(2),
  rain: CLOUD(-6, "var(--cloud-dark)") + DROPS(3),
  storm: CLOUD(-6, "var(--cloud-dark)") + `<path d="M34 42l-8 11h7l-4 9 11-13h-7l4-7z" fill="var(--sun)"/>`,
  snow: CLOUD(-6) + `<g fill="var(--snow)"><circle cx="23" cy="52" r="3"/><circle cx="33" cy="57" r="3"/><circle cx="43" cy="52" r="3"/></g>`,
};

// Texto de cada icono, para lectores de pantalla y para el bloque "Ahora".
export const ICON_LABELS = {
  clear: "Despejado", "clear-night": "Despejado", partly: "Poco nuboso", "partly-night": "Poco nuboso",
  cloudy: "Nublado", fog: "Niebla", drizzle: "Llovizna", rain: "Lluvia", storm: "Tormenta", snow: "Nieve",
};

export function iconSvg(key, size = 40) {
  const body = ICONS[key] || ICONS.cloudy;
  return `<svg class="wicon" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${ICON_LABELS[key] || ""}">${body}</svg>`;
}
