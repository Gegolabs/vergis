// El DICCIONARIO SEMÁNTICO de instancia (`VERGIS_SEMANTICA`, CAP-197).
//
// El test que justifica esta suite es el CONTROL POSITIVO DE ESCAPE: un `<script>` en una descripción
// tiene que salir como texto en la página que el nodo sirve bajo su propio gate. Quien pueda editar
// este YAML no puede, por esa vía, ejecutar código en el navegador de quien abra el catálogo — y eso
// es una propiedad que se mide, no una que se declara.

import { describe, it, expect } from 'vitest'
import { parseSemanticaConfig, semanticaEntidad, textoInline } from '../server/semantica-config'

describe('parseSemanticaConfig · claves raíz', () => {
  it('`semantica:` ausente es FATAL', () => {
    expect(() => parseSemanticaConfig({})).toThrow(/falta la clave raíz 'semantica'/)
  })
  it('`conexiones:` ausente dentro de `semantica:` también es FATAL — es LA lista', () => {
    expect(() => parseSemanticaConfig({ semantica: { portada: 'x' } })).toThrow(/falta la clave raíz 'conexiones'/)
  })
  it('`conexiones: []` es cero, legítimo', () => {
    const r = parseSemanticaConfig({ semantica: { conexiones: [] } })
    expect(r.conexiones).toEqual([])
    expect(r.warnings).toEqual([])
  })
})

describe('parseSemanticaConfig · entradas', () => {
  it('lee intro, joins y entidades, normalizando la llave de entidad', () => {
    const r = parseSemanticaConfig({
      semantica: {
        portada: 'Catálogo de la plataforma',
        seguridad: 'Hoy todo abierto a propósito',
        conexiones: [
          {
            conexion: 'finanzas',
            intro: 'Antigüedad de saldos',
            joins: ['fact × dim por Codigo'],
            entidades: { '[DBO].[Fact_Saldos]': { descripcion: 'El hecho', columnas: { Fecha_Carga: 'Semana' }, clase: 'interno' } },
          },
        ],
      },
    })
    expect(r.portada).toBe('Catálogo de la plataforma')
    expect(r.seguridad).toBe('Hoy todo abierto a propósito')
    expect(r.conexiones[0].entidades!['dbo.fact_saldos'].descripcion).toBe('El hecho')
    // La columna se indexa en minúsculas: la búsqueda es case-insensitive.
    expect(r.conexiones[0].entidades!['dbo.fact_saldos'].columnas).toEqual({ fecha_carga: 'Semana' })
    expect(r.conexiones[0].entidades!['dbo.fact_saldos'].clase).toBe('interno')
  })

  it('una entrada sin `conexion` se omite con aviso', () => {
    const r = parseSemanticaConfig({ semantica: { conexiones: [{ intro: 'x' }] } })
    expect(r.conexiones).toHaveLength(0)
    expect(r.warnings[0]).toMatch(/'conexion' debe ser un string no vacío/)
  })

  it('una entidad con llave sin esquema se omite con aviso; la conexión sobrevive', () => {
    const r = parseSemanticaConfig({ semantica: { conexiones: [{ conexion: 'f', entidades: { fact_saldos: { descripcion: 'x' }, 'dbo.ok': { descripcion: 'y' } } }] } })
    expect(Object.keys(r.conexiones[0].entidades!)).toEqual(['dbo.ok'])
    expect(r.warnings[0]).toMatch(/la entidad 'fact_saldos' se omite/)
  })

  it('una `clase` fuera del vocabulario se ignora con aviso, sin tirar la entidad', () => {
    const r = parseSemanticaConfig({ semantica: { conexiones: [{ conexion: 'f', entidades: { 'dbo.t': { descripcion: 'd', clase: 'raro' } } }] } })
    expect(r.conexiones[0].entidades!['dbo.t'].descripcion).toBe('d')
    expect(r.conexiones[0].entidades!['dbo.t'].clase).toBeUndefined()
    expect(r.warnings[0]).toMatch(/'clase' inválida 'raro'/)
  })

  it('una conexión declarada dos veces se omite la segunda', () => {
    const r = parseSemanticaConfig({ semantica: { conexiones: [{ conexion: 'f' }, { conexion: 'f' }] } })
    expect(r.conexiones).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/ya fue declarada/)
  })
})

describe('textoInline · ⚠ el control positivo de escape', () => {
  it('un `<script>` en una descripción sale como TEXTO, jamás como marcado', () => {
    const salida = textoInline('<script>alert(1)</script> y `col`')
    // REFUTARÍA: un `<script>` crudo acá significaría que editar el YAML de instancia es un canal
    // para ejecutar JavaScript en el navegador de quien abra el catálogo.
    expect(salida).not.toContain('<script>')
    expect(salida).toContain('&lt;script&gt;')
    // …y el acento grave, que es la ÚNICA marca admitida, sí se convierte.
    expect(salida).toContain('<code>col</code>')
  })

  it('un `<code>` escrito a mano sale como texto: se escapa PRIMERO y se re-admite después', () => {
    expect(textoInline('<code>x</code>')).toBe('&lt;code&gt;x&lt;/code&gt;')
  })

  it('un atributo con comillas o apóstrofes no puede cerrar el literal del HTML', () => {
    const salida = textoInline(`" onload="alert(1)" y ' otro`)
    expect(salida).not.toContain('onload="')
    expect(salida).toContain('&quot;')
    expect(salida).toContain('&#39;')
  })

  it('un acento grave impar no abre nada: queda como texto', () => {
    expect(textoInline('mitad `abierta')).toBe('mitad `abierta')
  })

  it('sin texto, cadena vacía (nunca `undefined` en la página)', () => {
    expect(textoInline(undefined)).toBe('')
    expect(textoInline('')).toBe('')
  })
})

describe('semanticaEntidad', () => {
  const cfg = parseSemanticaConfig({ semantica: { conexiones: [{ conexion: 'f', entidades: { 'dbo.t': { descripcion: 'd' } } }] } })
  it('encuentra por conexión + tabla normalizada', () => {
    expect(semanticaEntidad(cfg, 'f', '[dbo].[T]')?.descripcion).toBe('d')
    expect(semanticaEntidad(cfg, 'otra', 'dbo.t')).toBeUndefined()
    expect(semanticaEntidad(undefined, 'f', 'dbo.t')).toBeUndefined()
  })
})
