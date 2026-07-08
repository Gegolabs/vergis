import { describe, it, expect } from 'vitest'
import { annSign, verifyAnnToken } from '../server/annotations'

const SECRET = 'nodo-secret'

describe('anotaciones · gate HMAC (A15, adversarial)', () => {
  it('el token de (pi, email, key) valida para esa misma tripleta', () => {
    const tok = annSign(SECRET, 'qw-04', 'ana@x.com', 'fila-1')
    expect(verifyAnnToken(SECRET, 'qw-04', 'ana@x.com', 'fila-1', tok)).toBe(true)
  })

  it('NO valida para OTRA identidad (robar el token de otro no sirve)', () => {
    const tok = annSign(SECRET, 'qw-04', 'ana@x.com', 'fila-1')
    expect(verifyAnnToken(SECRET, 'qw-04', 'beto@x.com', 'fila-1', tok)).toBe(false)
  })

  it('NO valida para OTRA clave (forjar una fila no visible no produce token válido)', () => {
    const tok = annSign(SECRET, 'qw-04', 'ana@x.com', 'fila-1')
    expect(verifyAnnToken(SECRET, 'qw-04', 'ana@x.com', 'fila-99', tok)).toBe(false)
  })

  it('NO valida para OTRO PI', () => {
    const tok = annSign(SECRET, 'qw-04', 'ana@x.com', 'fila-1')
    expect(verifyAnnToken(SECRET, 'otro-pi', 'ana@x.com', 'fila-1', tok)).toBe(false)
  })

  it('NO valida con otro secreto (réplica sin el secreto compartido no puede firmar)', () => {
    const tok = annSign(SECRET, 'qw-04', 'ana@x.com', 'fila-1')
    expect(verifyAnnToken('otro-secret', 'qw-04', 'ana@x.com', 'fila-1', tok)).toBe(false)
  })

  it('clave vacía nunca valida', () => {
    expect(verifyAnnToken(SECRET, 'qw-04', 'ana@x.com', '', '')).toBe(false)
  })
})

describe('anotaciones · época del token (revocación no eterna)', () => {
  it('un token firmado en la época A valida mientras A esté aceptada', () => {
    const tok = annSign(SECRET, 'qw-04', 'ana@x.com', 'k', 'A')
    expect(verifyAnnToken(SECRET, 'qw-04', 'ana@x.com', 'k', tok, ['A'])).toBe(true)
    expect(verifyAnnToken(SECRET, 'qw-04', 'ana@x.com', 'k', tok, ['B', 'A'])).toBe(true) // tolera anterior
  })
  it('un token de una época YA fuera de ventana NO valida (revocación corta la escritura)', () => {
    const tok = annSign(SECRET, 'qw-04', 'ana@x.com', 'k', 'A')
    expect(verifyAnnToken(SECRET, 'qw-04', 'ana@x.com', 'k', tok, ['C', 'B'])).toBe(false)
  })
})
