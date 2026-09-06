#!/usr/bin/env node
// gen-instrumentos.mjs — el GENERADOR de la instancia sintética de Daftar para la prueba de carga.
//
// Escribe, en un directorio que después se monta en el nodo:
//
//   <dir>/specs/daftar.yaml            la spec del Let (identidad + padrón de estudiantes)
//   <dir>/identity/map.json            email → claims (`{ "e000@carga.local": { "student": ["e000"] } }`)
//   <dir>/instrumentos/guides/*.json   una guía POR estudiante virtual (+ las de siembra)
//   <dir>/instrumentos/{recursos,reports}/   vacíos, para que el catálogo no tropiece
//   <dir>/governance/                  el VERGIS_OUT compartido (lease + stores embebidos)
//
// ── Por qué UNA GUÍA POR ESTUDIANTE, y no una compartida ───────────────────────────────────────
// El intento del store tiene clave `(instrumento, estudiante)` y el dueño lo fija el METADATO de la
// guía (`let.ts`: `dueño = c.meta.student || s.student || ''`), no el que pide. Con una guía
// compartida los N estudiantes virtuales escribirían la MISMA fila y la corrida mediría
// serialización sobre un registro, no concurrencia. Y la visibilidad (`visible()`) exige
// `meta.student === claim`, así que además el 403 tapa el experimento.
//
// ── Por qué las guías de SIEMBRA son distintas de las de carga ─────────────────────────────────
// La serie S₁ necesita 5.000 intentos en el store. Un intento = un par (instrumento, estudiante) ⇒
// hacen falta 5.000 guías más. Son MÍNIMAS (una sección, un ítem) para que lo que crezca sea el
// store y no el peso del catálogo… pero **el catálogo crece igual en número de archivos**, y eso es
// un confundido declarado: entre S₀ y S₁ la clase `guides` (que enumera el directorio,
// `instrumentos.ts` `listar()`) no es comparable. La clase `progress-post` SÍ lo es: el POST no
// enumera el catálogo, solo abre su guía por id.
//
// Node ≥ 22, sin dependencias.
//
// Uso:
//   node deploy/carga/gen-instrumentos.mjs --dir /tmp/carga-daftar --estudiantes 200 --siembra 5000

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i]
  if (!t.startsWith('--')) continue
  const sig = process.argv[i + 1]
  if (sig === undefined || sig.startsWith('--')) args[t.slice(2)] = true
  else {
    args[t.slice(2)] = sig
    i++
  }
}

const DIR = args['dir'] ?? (console.error('gen: falta --dir'), process.exit(2))
const N = Number(args['estudiantes'] ?? 200)
const SIEMBRA = Number(args['siembra'] ?? 0)
const SECCIONES = Number(args['secciones'] ?? 3)
const ITEMS = Number(args['items'] ?? 8)
const DOMINIO = args['dominio'] ?? 'carga.local'
const ADMIN = args['admin-email'] ?? `admin@${DOMINIO}`
const LIMPIAR = args['limpiar'] === true

const pad = (n) => String(n).padStart(3, '0')
const pad4 = (n) => String(n).padStart(4, '0')

if (LIMPIAR) rmSync(DIR, { recursive: true, force: true })
for (const sub of ['specs', 'identity', 'governance', 'instrumentos/guides', 'instrumentos/recursos', 'instrumentos/reports']) {
  mkdirSync(join(DIR, sub), { recursive: true })
}

// ── La spec ────────────────────────────────────────────────────────────────────────────────────
// Solo los estudiantes de CARGA entran al padrón: los de siembra no lo necesitan (el Let resuelve al
// dueño por el metadato de la guía, y el padrón solo alimenta el selector del admin y `/api/students`).
// Meter 5.000 en la spec inflaría el HTML del shell y estaríamos midiendo el bootstrap, no el nodo.
const lineas = ['daftar_version: "1.0"', 'identity:', '  code: carga', '  display_name: "Daftar · carga"', 'estudiantes:']
for (let i = 0; i < N; i++) lineas.push(`  e${pad(i)}: { name: "Estudiante ${pad(i)}", grade: "8" }`)
writeFileSync(join(DIR, 'specs/daftar.yaml'), lineas.join('\n') + '\n')

// ── El mapa de identidad ───────────────────────────────────────────────────────────────────────
// Formato `{ email → { claim: valor(es) } }` (`identity-map-import.ts`, `IdentityMapFile`).
// El admin lleva `student: ["*"]` (el comodín del Let) para poder mirar el catálogo ajeno.
const mapa = { [ADMIN]: { student: ['*'] } }
for (let i = 0; i < N; i++) mapa[`e${pad(i)}@${DOMINIO}`] = { student: [`e${pad(i)}`] }
for (let i = 0; i < SIEMBRA; i++) mapa[`s${pad4(i)}@${DOMINIO}`] = { student: [`s${pad4(i)}`] }
writeFileSync(join(DIR, 'identity/map.json'), JSON.stringify(mapa, null, 1))

// ── Las guías ──────────────────────────────────────────────────────────────────────────────────
const guia = (id, estudiante, secciones, items) => ({
  title: `Instrumento de carga ${id}`,
  subtitle: 'Sintético — prueba de carga H1',
  institution: 'Banco de carga',
  subject: 'Carga',
  group: 'C1',
  variant: 'Evaluación',
  mode: 'practice',
  code: id.toUpperCase(),
  student: estudiante,
  confidence: true,
  sections: [...Array(secciones)].map((_, s) => ({
    id: `s${s}`,
    title: `Sección ${s + 1}`,
    type: 'multiple_choice',
    instructions: 'Marca la alternativa correcta.',
    exercises: [...Array(items)].map((_, e) => ({
      text: `Ítem ${s + 1}.${e + 1} — ¿cuál de estas alternativas es la correcta?`,
      options: ['Alternativa A', 'Alternativa B', 'Alternativa C', 'Alternativa D'],
      answer: (s + e) % 4,
    })),
  })),
})

const G = join(DIR, 'instrumentos/guides')
for (let i = 0; i < N; i++) {
  const id = `carga-${pad(i)}`
  writeFileSync(join(G, `${id}.json`), JSON.stringify(guia(id, `e${pad(i)}`, SECCIONES, ITEMS)))
}
for (let i = 0; i < SIEMBRA; i++) {
  const id = `siembra-${pad4(i)}`
  writeFileSync(join(G, `${id}.json`), JSON.stringify(guia(id, `s${pad4(i)}`, 1, 1)))
}

console.log(
  JSON.stringify(
    {
      dir: DIR,
      spec: `${N} estudiantes de carga`,
      guias: { carga: N, siembra: SIEMBRA, total: N + SIEMBRA },
      forma: { secciones: SECCIONES, items: ITEMS },
      identidades: Object.keys(mapa).length,
      admin: ADMIN,
    },
    null,
    2,
  ),
)
