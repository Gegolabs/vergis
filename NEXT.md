# NEXT — Vergis

El trabajo de producto de la sesión del 2026-08-07 está cerrado y sellado: `main` lleva `/contrato`
(#139 N1), la paralelización de la verificación fabric (#138·3) y los 11 diseños del cluster 004
que cubren todo el backlog público. Nada de eso queda en vuelo — lo que espera decisiones de César
vive en `PENDINGS.md`, no aquí. **El único hilo realmente en ejecución es una evaluación entre
modelos que quedó a un tercio de camino**, y es lo que este archivo pre-carga.

## Próximo paso

**Correr la sesión 2 (de 3) del A/B de `/ww:finaliza` entre Opus y Sonnet.** Desbloquea la decisión
de qué modelo se adopta para el comando de cierre: la regla del arnés exige que el modelo barato
llegue sin omisiones ni falsedades en **N≥3 sesiones distintas**, y solo se corrió 1.

**Contexto para arrancar en frío:**

- **El arnés (protocolo completo, léelo primero):**
  `~/.claude/protocolos/evals/finaliza/ARNES-v1.0.md` — §1 el guion del rewind, §4 la rúbrica,
  §5 la regla de decisión asimétrica.
- **Resultado de la sesión 1** (2026-08-07, espécimen: este mismo repo):
  `~/evals-finaliza/RESULTADOS.md` — **ganó Opus** (R1 3/3 y cero falsedades; Sonnet 1/3 con una
  falsedad: declaró «Pendientes nuevos: Ninguno» habiendo dos). Evidencia completa en
  `~/evals-finaliza/2026-08-07-vergis/`.
- **Cómo se corre una sesión de evaluación**, en orden: (1) congelar la clave de referencia ANTES
  de cualquier corrida — quién la escribe no puede ser quien juzga; (2) `/model sonnet` → correr
  `/ww:finaliza dry` pidiendo que escriba su reporte a
  `~/evals-finaliza/<AAAA-MM-DD>-<proyecto>/dry-<modelo>-<n>.md`; (3) **rewind restaurando solo la
  conversación, jamás los archivos** (restaurar archivos borraría el reporte recién escrito);
  (4) `/model opus` → misma invocación; (5) una repetición con el mismo modelo, de control de
  varianza; (6) juez ciego en sesión aparte, con los reportes renombrados `A.md`/`B.md`.
- **Verificación obligatoria al cerrar la tanda** (esto es lo que la sesión 1 aprendió a la mala):

  ```bash
  python3 -c "
  import json,sys
  prev=None
  for l in open(sys.argv[1]):
      try: d=json.loads(l)
      except: continue
      if d.get('type')!='assistant': continue
      m=d.get('message',{}).get('model')
      if m and m!=prev: print(d['timestamp'],'->',m); prev=m
  " ~/.claude/projects/<proyecto-con-guiones>/<session-id>.jsonl
  ```

  Imprime cada transición de modelo servido. Si no calzan con los `/model` tecleados, **la tanda no
  vale**. Es la única prueba dura de qué pesos corrieron.

**Trampas conocidas, todas pagadas en la sesión 1:**

- **El modelo miente sobre qué modelo es.** Con `/model` en Opus, el reporte se autoidentificó
  «Fable 5» (la línea de identidad del system prompt no sigue al `/model` — bug de plataforma ya
  reportado en anthropics/claude-code#77612). **Nombra los archivos con lo que TÚ viste en pantalla
  al teclear `/model`**, nunca con lo que el modelo dice ser.
- **No corras dos jueces a la vez.** En la sesión 1 hubo un subagente juez y un juicio manual
  simultáneos, escribiendo al mismo directorio (fenómeno W-01, ocurrencia 5). No hubo daño porque
  ambos hicieron append — pero declara de antemano quién juzga: el orquestador vía subagente
  **o** el operador a mano, nunca los dos.
- **El espécimen debe tener residuo real.** Una sesión trivial da empate entre modelos y no
  discrimina; hace falta que haya pendientes nuevos, algo resuelto a medias y al menos un registro
  que la sesión volvió falso.

## Terreno ya recorrido

- **Autoidentificación del modelo como fuente de verdad** — descartada: no es confiable
  (#77612). La autoridad es la confirmación de `/model` en pantalla, y la prueba dura es el
  transcript JSONL. No reintentar nombrar archivos desde el autorreporte.
- **Abrir un issue nuevo por el bug de autoidentificación** — descartado: ya existía upstream
  (#77612 y #77770). Se aportó como comentario. No re-reportar.
- **Interpretar el fenómeno como «asimetría Sonnet-acierta / Opus-falla»** — descartado, era
  falso: Sonnet no leía el system prompt, leía el eco del `/model` en el transcript. Dos versiones
  del reporte de bug murieron por esta confusión.

<!-- /ww:finaliza · 2026-08-07 · HEAD 6cc0bd7 -->
