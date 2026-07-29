// Enriquecimiento de PRESENTACIÓN de la capa de notas (vergis#84) — el único punto donde algo del
// store de notas toca el árbol resuelto.
//
// Qué hace: para cada tabla cuyo dataset declaró `anchor`, pregunta al llamador qué se ha comentado
// sobre las llaves de las filas QUE YA SE VAN A SERVIR, y anota el conteo en el nodo para que el
// render dibuje el marcador. Nada más.
//
// Qué NO hace, y es la regla (D7): **el motor jamás lee una nota**. Ninguna query, filtro, KPI,
// cruce ni orden depende de esto — corre DESPUÉS de componer, sobre el resultado ya cerrado, y si el
// resolver falla o no viene, el PI se sirve idéntico y sin marcadores. Las notas decoran lo que el
// dato dijo; no participan en decirlo.
//
// Fail-closed por construcción: solo viajan las llaves de filas ya filtradas por la RLS, y solo las
// que TIENEN comentarios (render escaso) — el payload no delata la existencia de filas no servidas.
import type { ResolvedNode } from './compose'

/** Conteo de lo comentado sobre una llave canónica. */
export interface ComentariosPorLlave {
  [llaveCanonica: string]: { count: number; porCampo: Record<string, number> }
}

/**
 * Resuelve qué se ha comentado. Lo provee el server (es quien tiene el store); recibe la entidad
 * gobernada y las filas servidas de esa tabla, y devuelve el mapa por llave canónica.
 */
export type ResolverComentarios = (
  entity: string,
  key: string[],
  rows: Record<string, unknown>[],
) => Promise<ComentariosPorLlave>

/** Todas las tablas ANCLADAS del árbol (DFS). */
function tablasAncladas(node: ResolvedNode, acc: ResolvedNode[] = []): ResolvedNode[] {
  if (node.type === 'table' && node.ancla) acc.push(node)
  for (const c of node.elements ?? []) tablasAncladas(c, acc)
  return acc
}

/**
 * Puebla `ancla.comentarios` de cada tabla anclada. Muta solo el nodo del árbol resuelto (que ya es
 * una copia por-request); jamás las filas de datos.
 */
export async function applyNotas(piece: ResolvedNode, resolver: ResolverComentarios): Promise<void> {
  await Promise.all(
    tablasAncladas(piece).map(async (t) => {
      const ancla = t.ancla!
      ancla.comentarios = await resolver(ancla.entity, ancla.key, t.rows ?? [])
    }),
  )
}
