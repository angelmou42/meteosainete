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
- Recuerda la **última ciudad** buscada (localStorage).

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
- **Sin dependencias ni compilación.** HTML, CSS y JavaScript a pelo: se abre
  tal cual y se publica en GitHub Pages sin configuración.

## Estructura

```
index.html   Estructura de la página
style.css    Estilos (modo claro/oscuro automático, adaptado a móvil)
app.js       Datos, consenso y dibujado
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

## Créditos

Datos meteorológicos de [Open-Meteo](https://open-meteo.com/) bajo licencia
CC BY 4.0.
