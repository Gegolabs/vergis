// Plantillas de publicación de jobs (issue #107 fase 2 · D3, D11, Δ1, Δ5): parser fail-closed del
// manifiesto, reglas de render sobre JSON parseado, y la carga en el arranque —manifiesto + partes
// relativas a su directorio— con su conteo en el summary.

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { canonicalDefinitionSha256, parseJobTemplatesConfig, renderTemplate, type JobTemplate } from '@vergis/capabilities'
import { loadInstanceConfig, type EnvLike, type ReadFile } from '../server/instance-config'

const MANIFIESTO =
  'templates:\n' +
  '  - id: sjd_ingesta_excel\n' +
  '    label: "Ingesta Excel (SJD estándar)"\n' +
  '    version: "1.0"\n' +
  '    itemType: SparkJobDefinition\n' +
  '    params:\n' +
  '      - { name: main_file, label: "Script principal (abfss)", required: true }\n' +
  '      - { name: lakehouse_id, label: "Lakehouse por defecto", required: true }\n' +
  '    parts:\n' +
  '      - { path: SparkJobDefinitionV1.json, file: parts/sjd.json }\n'

const PART_JSON = JSON.stringify({ executableFile: '{{main_file}}', defaultLakehouseArtifactId: '{{lakehouse_id}}', language: 'Python' })

const plantilla = (yaml: string = MANIFIESTO): JobTemplate => parseJobTemplatesConfig(parseYaml(yaml)).templates[0]
const partes = (json: string = PART_JSON): Record<string, string> => ({ 'SparkJobDefinitionV1.json': json })
const decode = (b64: string): unknown => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))

describe('job-templates · parse del manifiesto (fail-closed, contrato de tres estados)', () => {
  it('manifiesto válido: la plantilla sale completa, con los defaults de params', () => {
    const cfg = parseJobTemplatesConfig(parseYaml(MANIFIESTO))
    expect(cfg.templates).toHaveLength(1)
    expect(cfg.templates[0]).toMatchObject({
      id: 'sjd_ingesta_excel',
      label: 'Ingesta Excel (SJD estándar)',
      version: '1.0',
      itemType: 'SparkJobDefinition',
      params: [
        { name: 'main_file', label: 'Script principal (abfss)', required: true },
        { name: 'lakehouse_id', label: 'Lakehouse por defecto', required: true },
      ],
      parts: [{ path: 'SparkJobDefinitionV1.json', file: 'parts/sjd.json' }],
    })
  })

  it('clave raíz ausente → error nombrado (el archivo decapitado no pasa por vacío)', () => {
    expect(() => parseJobTemplatesConfig(parseYaml('otra_cosa: 1\n'))).toThrow(/job-templates: falta la clave raíz 'templates'/)
    expect(() => parseJobTemplatesConfig(parseYaml(''))).toThrow(/falta la clave raíz 'templates'/)
  })

  it('`templates: []` es legítimo: cero plantillas, sin error', () => {
    expect(parseJobTemplatesConfig(parseYaml('templates: []\n')).templates).toEqual([])
  })

  it('campos obligatorios y formas inválidas salen nombrando la plantilla', () => {
    const casos: [string, RegExp][] = [
      ['templates:\n  - label: X\n', /'id' debe ser un string no vacío/],
      ['templates:\n  - id: Mala_ID\n', /id inválido 'Mala_ID'/],
      ['templates:\n  - id: t\n    label: T\n    itemType: X\n    parts: []\n', /'version' debe ser un string no vacío/],
      ['templates:\n  - id: t\n    label: T\n    version: 1.0\n', /'version' debe ser un string no vacío \(entre comillas/],
      ['templates:\n  - id: t\n    label: T\n    version: "1"\n    parts: [{ path: p, file: f }]\n', /'itemType' debe ser un string no vacío/],
      ['templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n    parts: []\n', /'parts' no puede estar vacío/],
      ['templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n', /`parts` debe ser una lista/],
      [
        'templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n    parts: [{ path: p, file: a }, { path: p, file: b }]\n',
        /part duplicada 'p'/,
      ],
      [
        'templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n    params: [{ name: Mal }]\n    parts: [{ path: p, file: f }]\n',
        /nombre de parámetro inválido 'Mal'/,
      ],
      [MANIFIESTO + MANIFIESTO.replace('templates:\n', ''), /id de plantilla duplicado 'sjd_ingesta_excel'/],
    ]
    for (const [yaml, patron] of casos) expect(() => parseJobTemplatesConfig(parseYaml(yaml))).toThrow(patron)
  })
})

describe('job-templates · render (D11: sobre el JSON parseado, jamás por texto)', () => {
  it('render feliz: los valores entran como strings y el sha es el CANÓNICO', () => {
    const tpl = plantilla()
    const out = renderTemplate(tpl, partes(), { main_file: 'abfss://ws@onelake/lh/Files/code/ingesta.py', lakehouse_id: 'lh-123' })
    expect(out.parts).toHaveLength(1)
    expect(decode(out.parts[0].payloadBase64)).toEqual({
      executableFile: 'abfss://ws@onelake/lh/Files/code/ingesta.py',
      defaultLakehouseArtifactId: 'lh-123',
      language: 'Python',
    })
    expect(out.sha256).toBe(canonicalDefinitionSha256(out.parts))
  })

  it('un valor con comillas, llaves o con forma de placeholder NO rompe ni inyecta estructura', () => {
    const veneno = '", "language": "Scala", "x": {"y": 1}, "z": "{{lakehouse_id}}'
    const out = renderTemplate(plantilla(), partes(), { main_file: veneno, lakehouse_id: 'lh-1' })
    const doc = decode(out.parts[0].payloadBase64) as Record<string, unknown>
    expect(doc['executableFile']).toBe(veneno) // el veneno es UN string, entero
    expect(doc['language']).toBe('Python') // no se sobrescribió nada
    expect(Object.keys(doc).sort()).toEqual(['defaultLakehouseArtifactId', 'executableFile', 'language']) // ni se inyectaron claves
  })

  it('el sha del render es estable ante el orden de las parts declaradas', () => {
    const dosPartes =
      'templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n' +
      '    params: [{ name: p1 }]\n    parts: [{ path: a.json, file: a }, { path: b.json, file: b }]\n'
    const alReves = dosPartes.replace('[{ path: a.json, file: a }, { path: b.json, file: b }]', '[{ path: b.json, file: b }, { path: a.json, file: a }]')
    const files = { 'a.json': '{"v":"{{p1}}"}', 'b.json': '{"otro":1}' }
    const uno = renderTemplate(plantilla(dosPartes), files, { p1: 'x' })
    const dos = renderTemplate(plantilla(alReves), files, { p1: 'x' })
    expect(uno.sha256).toBe(dos.sha256)
    expect(uno.parts.map((p) => p.path)).not.toEqual(dos.parts.map((p) => p.path)) // el orden de salida sí difiere
  })

  it('placeholder presente pero NO declarado en params → error', () => {
    const tpl = plantilla('templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n    parts: [{ path: p.json, file: f }]\n')
    expect(() => renderTemplate(tpl, { 'p.json': '{"a":"{{fantasma}}"}' }, {})).toThrow(/usa el placeholder '\{\{fantasma\}\}' pero 'params' no lo declara/)
  })

  it('parámetro declarado sin placeholder en ninguna parte → error', () => {
    const tpl = plantilla(
      'templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n    params: [{ name: huerfano }]\n    parts: [{ path: p.json, file: f }]\n',
    )
    expect(() => renderTemplate(tpl, { 'p.json': '{"a":1}' }, { huerfano: 'v' })).toThrow(/el parámetro 'huerfano' está declarado pero ninguna parte lo usa/)
  })

  it('placeholder requerido sin valor → error; valor no declarado → error', () => {
    expect(() => renderTemplate(plantilla(), partes(), { main_file: 'x' })).toThrow(/falta el valor del parámetro requerido 'lakehouse_id'/)
    expect(() => renderTemplate(plantilla(), partes(), { main_file: 'x', lakehouse_id: '  ' })).toThrow(/falta el valor del parámetro requerido 'lakehouse_id'/)
    expect(() => renderTemplate(plantilla(), partes(), { main_file: 'x', lakehouse_id: 'l', sobra: 'v' })).toThrow(
      /se dio un valor para 'sobra', que la plantilla no declara como parámetro/,
    )
  })

  it('un parámetro opcional sin valor se sustituye por cadena vacía, sin romper', () => {
    const tpl = plantilla(
      'templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n' +
        '    params: [{ name: extra, required: false }]\n    parts: [{ path: p.json, file: f }]\n',
    )
    expect(decode(renderTemplate(tpl, { 'p.json': '{"a":"{{extra}}"}' }, {}).parts[0].payloadBase64)).toEqual({ a: '' })
  })

  it('placeholder EMBEBIDO en un string más largo, o en una clave, es error (no valor completo)', () => {
    const tpl = plantilla(
      'templates:\n  - id: t\n    label: T\n    version: "1"\n    itemType: X\n    params: [{ name: p1 }]\n    parts: [{ path: p.json, file: f }]\n',
    )
    expect(() => renderTemplate(tpl, { 'p.json': '{"a":"prefijo/{{p1}}"}' }, { p1: 'v' })).toThrow(/placeholder mal puesto/)
    expect(() => renderTemplate(tpl, { 'p.json': '{"a":"{{ p1 }}"}' }, { p1: 'v' })).toThrow(/placeholder mal puesto/)
    expect(() => renderTemplate(tpl, { 'p.json': '{"{{p1}}":"a"}' }, { p1: 'v' })).toThrow(/placeholder en la clave/)
  })

  it('una parte que no es JSON válido, o que falta, sale nombrada', () => {
    const tpl = plantilla()
    expect(() => renderTemplate(tpl, partes('{roto'), {})).toThrow(/la parte 'SparkJobDefinitionV1\.json' \(parts\/sjd\.json\) no es JSON válido/)
    expect(() => renderTemplate(tpl, {}, {})).toThrow(/falta el contenido de la parte 'SparkJobDefinitionV1\.json'/)
  })
})

describe('job-templates · carga de instancia VERGIS_JOB_TEMPLATES (Δ5, solo-arranque)', () => {
  /** `readFile` de mentira, indexado por sufijo de ruta (mismo arnés que `instance-config.test.ts`). */
  const fs = (files: Record<string, string>): ReadFile => {
    return (path: string) => {
      const hit = Object.entries(files).find(([name]) => path.endsWith(name))
      if (!hit) throw new Error(`ENOENT: ${path}`)
      return hit[1]
    }
  }
  const env: EnvLike = { VERGIS_JOB_TEMPLATES: 'cfg/job-templates.yaml' }

  it('sin el env: cero plantillas y ninguna mención en el summary', () => {
    const cfg = loadInstanceConfig({}, fs({}))
    expect(cfg.jobTemplates).toEqual([])
    expect(cfg.summary).toBe('')
  })

  it('con el env: la plantilla queda cargada CON sus partes crudas y el conteo aparece en el summary', () => {
    const cfg = loadInstanceConfig(env, fs({ 'job-templates.yaml': MANIFIESTO, 'sjd.json': PART_JSON }))
    expect(cfg.summary).toBe('jobs-templates 1')
    expect(cfg.jobTemplates).toHaveLength(1)
    expect(cfg.jobTemplates[0].template.id).toBe('sjd_ingesta_excel')
    expect(cfg.jobTemplates[0].partFiles).toEqual({ 'SparkJobDefinitionV1.json': PART_JSON })
    // Lo cargado renderiza sin volver a disco.
    const { template, partFiles } = cfg.jobTemplates[0]
    expect(renderTemplate(template, partFiles, { main_file: 'a', lakehouse_id: 'b' }).parts).toHaveLength(1)
  })

  it('las rutas `file:` se resuelven RELATIVAS AL DIRECTORIO del manifiesto', () => {
    const vistas: string[] = []
    const read: ReadFile = (path) => {
      vistas.push(path)
      return path.endsWith('job-templates.yaml') ? MANIFIESTO : PART_JSON
    }
    loadInstanceConfig(env, read)
    expect(vistas[0]).toBe(resolve('cfg/job-templates.yaml'))
    expect(vistas[1]).toBe(resolve('cfg/parts/sjd.json'))
  })

  it('clave raíz ausente → error de arranque con ENV y ruta absoluta', () => {
    expect(() => loadInstanceConfig(env, fs({ 'job-templates.yaml': 'otra: 1\n' }))).toThrow(
      /VERGIS_JOB_TEMPLATES \(\/.*job-templates\.yaml\): job-templates: falta la clave raíz 'templates'/,
    )
  })

  it('parte inexistente → error de arranque nombrando ENV, plantilla y la ruta de la parte', () => {
    const llamar = (): unknown => loadInstanceConfig(env, fs({ 'job-templates.yaml': MANIFIESTO }))
    expect(llamar).toThrow(/VERGIS_JOB_TEMPLATES/)
    expect(llamar).toThrow(/plantilla 'sjd_ingesta_excel': no se pudo leer la parte 'SparkJobDefinitionV1\.json'/)
    expect(llamar).toThrow(/parts\/sjd\.json/)
  })

  it('manifiesto incoherente con sus partes (placeholder no declarado) tumba el ARRANQUE, no la publicación', () => {
    expect(() => loadInstanceConfig(env, fs({ 'job-templates.yaml': MANIFIESTO, 'sjd.json': '{"a":"{{fantasma}}"}' }))).toThrow(
      /VERGIS_JOB_TEMPLATES .*usa el placeholder '\{\{fantasma\}\}' pero 'params' no lo declara/s,
    )
  })

  it('NO es recargable en caliente: `VERGIS_JOB_TEMPLATES` no está en RELOADABLE_SLICES (Δ5)', async () => {
    const { RELOADABLE_SLICES } = await import('../server/instance-config')
    expect(Object.values(RELOADABLE_SLICES).map((s) => s.env)).not.toContain('VERGIS_JOB_TEMPLATES')
  })
})

describe('job-templates · el ejemplo del repo no se pudre', () => {
  const EJEMPLO = fileURLToPath(new URL('../examples/job-templates.yaml', import.meta.url))

  it('`examples/job-templates.yaml` carga como config de instancia y renderiza', () => {
    const cfg = loadInstanceConfig({ VERGIS_JOB_TEMPLATES: EJEMPLO }, (p) => readFileSync(p, 'utf8'))
    expect(cfg.summary).toBe('jobs-templates 1')
    const { template, partFiles } = cfg.jobTemplates[0]
    expect(template.itemType).toBe('SparkJobDefinition')
    const out = renderTemplate(template, partFiles, {
      main_file: 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Files/code/ingesta.py',
      lakehouse_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(out.parts.map((p) => p.path)).toEqual(['SparkJobDefinitionV1.json'])
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
