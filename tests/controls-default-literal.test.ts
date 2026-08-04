// #92 · `controls[].default` acepta un VALOR LITERAL, no solo `max|min|first`.
// Semántica: el literal gana si es una de las opciones RESUELTAS al render; fuera del dominio cae al
// comportamiento sin default (fail-safe — el dominio lo produce el SQL y puede moverse bajo un spec
// quieto). Los keywords conservan su semántica aunque el dominio contenga un valor homónimo.
import { describe, expect, it } from 'vitest'
import { resolveControlValue, resolveControlValues } from '@vergis/mira'

const SEMANAS = ['W30', 'W31', 'W32', 'W33']

describe('#92 · default literal en un control single', () => {
  it('el literal gana cuando está en el dominio', () => {
    expect(resolveControlValue(undefined, SEMANAS, 'W32')).toBe('W32')
  })
  it('fuera del dominio cae al comportamiento sin default (max) — fail-safe', () => {
    expect(resolveControlValue(undefined, SEMANAS, 'W99')).toBe('W33')
  })
  it('la URL sigue ganando sobre el literal', () => {
    expect(resolveControlValue('W30', SEMANAS, 'W32')).toBe('W30')
  })
  it('los keywords conservan su semántica', () => {
    expect(resolveControlValue(undefined, SEMANAS, 'max')).toBe('W33')
    expect(resolveControlValue(undefined, SEMANAS, 'min')).toBe('W30')
    expect(resolveControlValue(undefined, SEMANAS, 'first')).toBe('W30')
  })
  it('keyword gana sobre un valor homónimo del dominio', () => {
    // dominio patológico que contiene el string 'max': el keyword sigue siendo keyword
    expect(resolveControlValue(undefined, ['a', 'max', 'z'], 'max')).toBe('z')
  })
  it('sin opciones, cadena vacía (sin inventar el literal)', () => {
    expect(resolveControlValue(undefined, [], 'W32')).toBe('')
  })
})

describe('#92 · default literal en un control multi-select', () => {
  it('sin selección válida en la URL, el literal puebla la selección', () => {
    expect(resolveControlValues(undefined, SEMANAS, 'W31')).toEqual(['W31'])
  })
  it('literal fuera del dominio → fallback (max)', () => {
    expect(resolveControlValues(undefined, SEMANAS, 'W99')).toEqual(['W33'])
  })
})
