/**
 * #263 · Realce del rótulo bajo el cursor — el segundo gesto estándar sobre el SVG horneado.
 *
 * **Qué resuelve:** en una línea larga el stride solo deja ver algunos rótulos, así que el valor de
 * la mayoría de los puntos no se lee en la lámina. El tooltip nativo (#208) lo da uno por uno; este
 * gesto además **enfatiza el rótulo del punto apuntado**, que es la lectura que el especificador
 * pidió.
 *
 * **Por qué hay JS y no solo CSS, MEDIDO sobre el SVG que emite Vega:** el `<path>` de la marca y el
 * `<text>` de su rótulo comparten la llave (`aria-label`, que el canal `description` escribe en los
 * dos) pero viven en `<g>` **distintos** — capas separadas del layer de vega-lite. Ningún selector
 * CSS cruza de un grupo al hijo de otro; `:has()` tampoco, porque sube al ancestro y no baja a un
 * hermano lejano. El emparejamiento se resuelve entonces en el cliente, sobre el SVG ya renderizado.
 *
 * **Lo que NO es:** no hay motor de gráficos en el navegador, no hay runtime de Vega, no hay estado
 * que sincronizar y no viaja dato alguno. Es un listener delegado que conmuta una clase.
 *
 * **Táctil:** solo `mouseover`/`mouseout`. En un dispositivo sin puntero no hay hover — igual que el
 * tooltip nativo — y no se promete lo que no existe.
 */

/** Hoja del realce. `opacity` gana al atributo de presentación `opacity="0"` de los ocultos. */
export const CHART_HOVER_CSS = `
.chart text[aria-roledescription="text mark"]{transition:font-size .12s ease,opacity .12s ease}
.chart text.vrz{font-size:15px;font-weight:700;opacity:1}
`

/** Runtime del realce: un listener por evento en `document`, sin costo por marca. */
export const CHART_HOVER_SOURCE = `(function(){
  function mark(el, on){
    if (!el || !el.closest) return;
    var p = el.closest('section.chart path[aria-label]'); if (!p) return;
    var svg = p.closest('svg'); if (!svg) return;
    var k = p.getAttribute('aria-label');
    svg.querySelectorAll('text[aria-label]').forEach(function(t){
      if (t.getAttribute('aria-label') === k) t.classList.toggle('vrz', on);
    });
  }
  document.addEventListener('mouseover', function(ev){ mark(ev.target, true) });
  document.addEventListener('mouseout', function(ev){ mark(ev.target, false) });
})();`
