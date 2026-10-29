# Meteosainete

Cada web del tiempo da una predicción distinta, pero casi todas se basan en los
mismos pocos **modelos meteorológicos**. Meteosainete compara directamente esos
modelos, los pone uno al lado del otro y calcula un **consenso** con un
indicador de **fiabilidad**: si los modelos coinciden, te puedes fiar más.

## Qué muestra

- **Franja de 7 días** con el consenso: máxima y mínima (mediana de los
  modelos), probabilidad y cantidad de lluvia, cuántos modelos dan lluvia y la
  fiabilidad (alta, media o baja).
- **Tabla modelo × día** con pestañas Temperatura / Lluvia / Viento y una fila
  final de consenso.
- **Gráfico hora a hora** del día elegido: una línea por modelo, una banda gris
  con el rango entre modelos y la mediana discontinua.
- **Mapas de lluvia** en su propia pestaña (enlace directo: `#mapa`):
  - **Por día y hora**: mapa propio con los 6 modelos, botones de día y una
    barra de hora. Al pulsar un punto muestra los mm previstos.
  - **Windy animado**: mapa incrustado de [Windy](https://www.windy.com/)
    (ECMWF, GFS e ICON-EU), con más detalle pero con su propia línea de tiempo.
- Recuerda la **última ciudad** buscada (localStorage). La primera vez se
  abre en Arjona (Jaén).

## Modelos

| Modelo        | Origen       | Notas |
|---------------|--------------|-------|
| ECMWF IFS     | Europa       | |
| GFS           | EE. UU.      | |
| ICON          | Alemania     | |
| Météo-France  | Francia      | Unos 4 días de alcance. No publica probabilidad de lluvia. |
| UKMO          | Reino Unido  | |
| GEM           | Canadá       | |

Comprobado con datos reales (octubre de 2026): todos publican
`precipitation_probability_max` salvo Météo-France.

## Decisiones de diseño

- **Comparar modelos, no webs.** Sin scraping: los datos salen de la API de
  [Open-Meteo](https://open-meteo.com/), que es gratuita, no necesita clave y
  permite llamadas desde el navegador (CORS). Una sola petición trae los 6
  modelos; la API añade un sufijo a cada variable
  (`temperature_2m_max_ecmwf_ifs025`) y `fetchForecast()` lo reorganiza por
  modelo.
- **Mediana en lugar de media.** Si un modelo se desvía mucho, la mediana casi
  no se mueve; la media sí.
- **Fiabilidad.** *Alta* si las máximas difieren ≤ 2 °C y todos los modelos
  coinciden en si llueve (≥ 1 mm). *Media* hasta 4 °C o si una minoría
  discrepa sobre la lluvia. *Baja* en el resto.
- **Huecos honestos.** Si un modelo no llega a un día, se ve "—" y no cuenta
  para el consenso ni para el "Lo dan X de N".
- **Probabilidad estimada.** Para Météo-France se muestra una estimación a
  partir de los mm, marcada con "≈" y en cursiva. Es orientativa, por eso
  **no entra en el consenso**.
- **Solo datos reales.** Si la API falla, se muestra un error claro con un
  botón de reintentar, nunca datos inventados.
- **Dos mapas, cada uno para lo que hace mejor.** El iframe de Windy no deja
  elegir la hora desde fuera, así que hay un mapa propio: una rejilla de
  8 × 16 puntos de Open-Meteo pintada en un `<canvas>` con interpolación
  bilineal sobre [Leaflet](https://leafletjs.com/). Se descargan los 7 días
  de golpe, así que cambiar de día u hora es instantáneo. Windy se mantiene
  como vista animada con más detalle.
- **Cuidar la cuota de Open-Meteo.** Cada punto de la rejilla cuenta como una
  llamada (límite gratuito: 600 por minuto y usuario), por eso la rejilla es
  pequeña y cada modelo descargado se guarda una hora en `sessionStorage`.
- **Nada pesado hasta que hace falta.** Leaflet, las rejillas y Windy solo se
  descargan al abrir la pestaña de mapas. Leaflet se carga con SRI
  (`integrity`) para que el navegador lo rechace si el CDN lo alterase.
- **Versiones en CSS y JS** (`style.css?v=5`). GitHub Pages deja que el
  navegador guarde los archivos 10 minutos; al cambiar el número tras cada
  cambio importante, nadie ve HTML nuevo mezclado con CSS o JS viejos.
- **Sin compilación.** HTML, CSS y JavaScript a pelo, sin npm: se abre tal
  cual y se publica en GitHub Pages sin configuración. La única librería
  (Leaflet) se carga desde un CDN.

## Estructura

```
index.html   Estructura de la página
style.css    Estilos (modo claro/oscuro automático, adaptado a móvil)
app.js       Datos, consenso, tabla y gráfico
map.js       Mapas de lluvia (mapa propio con Leaflet y Windy)
```

## Ejecutarlo en local

Basta con servir la carpeta con cualquier servidor estático, por ejemplo:

```bash
python -m http.server 8000
```

y abrir <http://localhost:8000>.



## Ideas para el futuro

- Añadir la predicción oficial de AEMET (API AEMET OpenData) como séptima fila,
  con un pequeño proxy para no exponer la clave.
- Probabilidad de lluvia por horas en el gráfico.
- Radar de lluvia en tiempo real (AEMET o RainViewer) junto al mapa.

## Créditos

Datos meteorológicos de [Open-Meteo](https://open-meteo.com/) bajo licencia
CC BY 4.0. Mapa base de Esri. Mapa animado de Windy.
