/* Capturas de pantalla para el README, sin dependencias.
 *
 * Abre Edge (o Chrome) sin ventana con el protocolo de depuración activado y
 * lo maneja con el WebSocket que trae Node: carga la web, espera a que lleguen
 * los datos y guarda capturas de escritorio y de móvil en img/capturas/.
 *
 * Uso (con la web servida en local, p. ej. python -m http.server 8931):
 *   node herramientas/capturas.mjs [url-base]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8931/";
const PLACE = "?lugar=Arjona%2C+Ja%C3%A9n&lat=37.935&lon=-4.055";
const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
];
const PORT = 9333;
const OUT = new URL("../img/capturas/", import.meta.url);

// Cada captura: nombre, tamaño de pantalla, escala, si es móvil, tema y qué hacer antes.
const SHOTS = [
  { name: "escritorio", width: 1280, height: 1500, scale: 1, mobile: false, theme: "dark", hash: "" },
  { name: "escritorio-claro", width: 1280, height: 1500, scale: 1, mobile: false, theme: "light", hash: "" },
  { name: "movil", width: 390, height: 1700, scale: 2, mobile: true, theme: "dark", hash: "" },
  { name: "acierto", width: 1280, height: 1100, scale: 1, mobile: false, theme: "dark", hash: "#acierto" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const exe = BROWSERS.find((p) => existsSync(p)) ?? BROWSERS[0];
  const profile = join(tmpdir(), "meteosainete-capturas");
  const browser = spawn(exe, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  try {
    await sleep(2500);
    mkdirSync(OUT, { recursive: true });
    for (const shot of SHOTS) {
      const png = await capture(shot);
      writeFileSync(new URL(`${shot.name}.png`, OUT), png);
      console.log(`img/capturas/${shot.name}.png`);
    }
  } finally {
    browser.kill();
  }
}

// Abre una pestaña nueva, la prepara y devuelve la captura en PNG.
async function capture(shot) {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    const onMessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== msgId) return;
      ws.removeEventListener("message", onMessage);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: shot.height, deviceScaleFactor: shot.scale, mobile: shot.mobile });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: shot.theme }] });
  await send("Page.navigate", { url: BASE + PLACE + shot.hash });
  // Espera a que la predicción esté pintada (el bloque "Ahora" deja de estar vacío).
  for (let k = 0; k < 40; k++) {
    await sleep(500);
    const r = await send("Runtime.evaluate", { expression: "document.getElementById('now')?.children.length > 0", returnByValue: true });
    if (r.result.value) break;
  }
  await sleep(shot.wait || 2500); // tiempo extra para fuentes, mapas y resultados
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  return Buffer.from(data, "base64");
}

main().catch((err) => { console.error(err); process.exit(1); });
