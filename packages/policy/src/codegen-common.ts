// Helpers COMUNES a los back-ends del compilador (ClickHouse y Fabric). Ambos motores materializan la
// misma Policy IR con SQL distinto, pero comparten las primitivas de seguridad de nombres y el contrato
// del transporte de claims (custom setting `vergis_claim_<claim>`). Vivían duplicadas en `clickhouse.ts`
// y `fabric.ts`; un solo lugar evita que las dos copias diverjan (p.ej. un patrón de identificador
// endurecido en un motor y no en el otro). Ref: NEXT.md · Ola 3·B (04·16).
import { VergisError } from '@vergis/botler'

/** Prefijo de los custom settings que transportan los claims (request-scoped): `vergis_claim_<claim>`. */
export const SETTINGS_PREFIX = 'vergis_'

/** Identificadores seguros (columna, claim, rol, tabla, schema): evita inyección por nombre en el DDL,
 *  que se construye por interpolación de string (ningún motor parametriza identificadores). */
export const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Valida un identificador contra `SAFE_IDENT` o LANZA un error de codegen estructurado y accionable. */
export function ident(kind: string, value: string): string {
  if (!SAFE_IDENT.test(value)) {
    throw new VergisError({
      error: 'policy/codegen',
      code: 'unsafe-identifier',
      path: kind,
      value,
      message: `'${value}' no es un identificador seguro para ${kind} (esperado ${SAFE_IDENT}).`,
      remediation: `Usar solo letras, dígitos y guion bajo en ${kind}.`,
    })
  }
  return value
}

/** Nombre del custom setting que transporta los valores permitidos de un claim. */
export function settingForClaim(claim: string): string {
  return `${SETTINGS_PREFIX}claim_${ident('claim', claim)}`
}
