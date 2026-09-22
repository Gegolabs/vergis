/**
 * Escritor XLSX de UNA hoja, propio y sin dependencias (issue #306 · I8 · despacho P-3 de César).
 *
 * POR QUÉ EXISTE, y por qué no contradice la decisión #61. En #61 (2026-07-13) César descartó el
 * `.xlsx` por su COSTO —«la primera dependencia gorda del producto y un endpoint server-side, sin
 * demanda que lo justifique»—, no por el formato. Esta vía no paga ninguno de los dos: son ~120
 * líneas sin dependencias y corre en el navegador sobre el resultset que ya está en la página.
 *
 * DOS DECISIONES DE COSTO, dichas porque el diseño las dejó como conjetura a medir:
 *
 *  1. **ZIP `stored`, sin `deflate`.** Un `.xlsx` es un ZIP; comprimir exigiría `CompressionStream
 *     ('deflate-raw')`, cuyo soporte en los navegadores de la instancia NO está verificado. Sin
 *     compresión el archivo es más grande y el código no tiene ninguna conjetura adentro: para un
 *     resultset acotado por `maxRows` el tamaño no es un problema, y una conjetura sí lo es.
 *  2. **Sin `styles.xml`.** Una fecha con `t="d"` necesita un estilo con formato de fecha para
 *     verse como fecha; sin él, Excel muestra cualquier cosa. Antes que emitir un archivo que
 *     depende de algo que no medí, las fechas viajan como TEXTO ISO — se ve lo que dice el dato.
 *
 * Y una que es de seguridad: **jamás se emite `<f>`** (fórmula). Un `=1+1` viaja como `inlineStr`,
 * o sea como texto, y por eso no hace falta la neutralización con `'` que el CSV sí necesita (allí
 * el archivo se PARSEA al abrirlo; acá el tipo de la celda lo declara el XML). Prefijar acá
 * corrompería el valor sin ganar nada.
 *
 * AUTOCONTENIDA a propósito (sin imports, sin helpers): viaja al navegador vía `.toString()`, igual
 * que las puras de `table-runtime`.
 */
export function xlsxUnaHoja(columnas: string[], filas: unknown[][], hoja = 'Consulta'): Uint8Array {
  const esc = (s: string): string =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // A, B, … Z, AA, AB … — la referencia de columna de una celda.
  const col = (n: number): string => {
    let s = ''
    let i = n
    while (i >= 0) {
      s = String.fromCharCode(65 + (i % 26)) + s
      i = Math.floor(i / 26) - 1
    }
    return s
  }
  const celda = (ref: string, v: unknown): string => {
    if (v == null || v === '') return ''
    if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`
    const texto = v instanceof Date ? v.toISOString() : String(v)
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(texto)}</t></is></c>`
  }
  const lineas: string[] = []
  lineas.push(`<row r="1">${columnas.map((c, i) => celda(`${col(i)}1`, c)).join('')}</row>`)
  filas.forEach((fila, f) => {
    const r = f + 2
    lineas.push(`<row r="${r}">${fila.map((v, i) => celda(`${col(i)}${r}`, v)).join('')}</row>`)
  })
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${lineas.join('')}</sheetData></worksheet>`
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${esc(hoja).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  const wbRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`

  // ── ZIP `stored` ─────────────────────────────────────────────────────────────────────────────
  const enc = new TextEncoder()
  const tabla: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    tabla.push(c >>> 0)
  }
  const crc32 = (b: Uint8Array): number => {
    let c = 0xffffffff
    for (let i = 0; i < b.length; i += 1) c = tabla[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const partes = [
    { nombre: '[Content_Types].xml', datos: enc.encode(types) },
    { nombre: '_rels/.rels', datos: enc.encode(rels) },
    { nombre: 'xl/workbook.xml', datos: enc.encode(workbook) },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: enc.encode(wbRels) },
    { nombre: 'xl/worksheets/sheet1.xml', datos: enc.encode(sheet) },
  ]
  const trozos: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const u16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff]
  const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
  for (const parte of partes) {
    const nombre = enc.encode(parte.nombre)
    const crc = crc32(parte.datos)
    const cab = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(parte.datos.length), ...u32(parte.datos.length),
      ...u16(nombre.length), ...u16(0), ...nombre,
    ])
    trozos.push(cab, parte.datos)
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(parte.datos.length), ...u32(parte.datos.length),
        ...u16(nombre.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
        ...nombre,
      ]),
    )
    offset += cab.length + parte.datos.length
  }
  const dirLargo = central.reduce((n, c) => n + c.length, 0)
  const fin = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(partes.length), ...u16(partes.length),
    ...u32(dirLargo), ...u32(offset), ...u16(0),
  ])
  const todo = [...trozos, ...central, fin]
  const total = todo.reduce((n, c) => n + c.length, 0)
  const salida = new Uint8Array(total)
  let p = 0
  for (const c of todo) {
    salida.set(c, p)
    p += c.length
  }
  return salida
}
