// predicate.mjs — EL predicado que decide «sano», escrito una vez para todo el plugin:
//
//     HTTP 200  ∧  "phase":"serving"  ∧  lets.serving == lets.total
//
// Nunca «responde», nunca `r.ok`, nunca «2xx a secas»: un nodo en espera responde 200 con `ok:true`
// POR DISEÑO. El cuerpo se parsea como JSON, jamás por regexp: la sala de espera del borde lleva el
// literal `"phase":"serving"` en un comentario, y un extractor por regexp le lee `serving` a un error
// del borde (hallazgo del banco V-14). Lee `lets` y cae a `pis` (nodos < 0.27.0) DICIENDO cuál leyó;
// conteos sueltos fuera de los dos bloques son un contrato que este predicado no sabe leer ⇒ MAL.
//
// El mismo texto viaja literal a los contenedores (`PREDICATE_JS`): una sola implementación.

export const PREDICATE_JS = String.raw`function juzgar(status, body) {
  let j = null
  try { j = JSON.parse(body) } catch {}
  const phase = j && typeof j.phase === 'string' ? j.phase : null
  const blk = j && j.lets && Number.isFinite(j.lets.total) ? ['lets', j.lets.total, j.lets.serving]
    : j && j.pis && Number.isFinite(j.pis.total) ? ['pis', j.pis.total, j.pis.serving]
    : null
  const sueltos = !!(j && (Number.isFinite(j.total) || Number.isFinite(j.serving)))
  const ok = status === 200 && phase === 'serving' && !sueltos && (!blk || blk[1] === blk[2])
  return { ok, status, phase, block: blk ? blk[0] : null, total: blk ? blk[1] : null, serving: blk ? blk[2] : null, json: !!j, sueltos }
}`

// eslint-disable-next-line no-new-func
export const juzgar = new Function(`${PREDICATE_JS}; return juzgar`)()
