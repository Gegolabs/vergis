// #266 (segunda mitad) · Un fallo del ARRANQUE de Miranda (catálogo, roster, store) apaga la superficie
// con su razón en vez de tumbar el nodo. Lo que se mide acá es puro: la vista del contrato con un
// `bootFailure`, la clasificación del roster, y que el roster inválido siga LANZANDO (es ese throw el
// que el catch de serve-rls convierte en degradación — sin throw no habría nada que degradar).
import { describe, expect, it } from 'vitest'
import { mirandaContractView } from '../server/miranda'
import { FATAL_ENVS, DEGRADABLE_ENVS, parsePreviewIdentities } from '../server/config'

const ON = { enabled: true, model: 'claude-sonnet-5', apiKey: 'k' }

describe('#266 · el contrato con Miranda caída en el arranque', () => {
  it('bootFailure ⇒ enabled=false, requested=true, la razón es la del arranque, sin model ni baseUrl', () => {
    const v = mirandaContractView(ON, 'MIRANDA_PREVIEW_IDENTITIES apunta a un roster ilegible (/x/roster.json): ENOENT')
    expect(v.enabled).toBe(false)
    expect(v.requested).toBe(true)
    expect(v.disabledReason).toContain('roster ilegible')
    expect(v.model).toBeUndefined()
    expect(v.baseUrl).toBeUndefined()
  })
  it('control: sin bootFailure la vista es la viva (enabled, model y destino)', () => {
    const v = mirandaContractView(ON, null)
    expect(v).toMatchObject({ enabled: true, requested: true, model: 'claude-sonnet-5' })
    expect(v.baseUrl).toBeTruthy()
    expect(v.disabledReason).toBeUndefined()
  })
  it('la razón de configuración gana a la del arranque (no puede haber arranque si la config no alcanzó)', () => {
    const v = mirandaContractView({ enabled: false, disabledReason: 'falta ANTHROPIC_API_KEY', model: 'm', apiKey: '' }, 'x')
    expect(v.disabledReason).toBe('falta ANTHROPIC_API_KEY')
    expect(v.requested).toBe(true)
  })
})

describe('#266 · el roster deja de ser fatal', () => {
  it('MIRANDA_PREVIEW_IDENTITIES está en DEGRADABLE y no en FATAL', () => {
    expect(DEGRADABLE_ENVS.flatMap((e) => e.envs)).toContain('MIRANDA_PREVIEW_IDENTITIES')
    expect(FATAL_ENVS.flatMap((e) => e.envs)).not.toContain('MIRANDA_PREVIEW_IDENTITIES')
  })
  it('un roster inválido SIGUE lanzando (es el throw que el arranque convierte en apagado con razón)', () => {
    expect(() => parsePreviewIdentities('{"no":"es un roster"}')).toThrow()
    expect(() => parsePreviewIdentities('esto no es json')).toThrow()
  })
})
