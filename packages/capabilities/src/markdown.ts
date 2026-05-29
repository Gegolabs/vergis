/** Renderer markdown mínimo para v0.1: encabezados ATX y párrafos. Sin Vega, sin libs. */
export function renderMarkdown(md: string): string {
  return md
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (t === '') return ''
      const heading = /^(#{1,6})\s+(.*)$/.exec(t)
      if (heading) {
        const level = heading[1].length
        return `<h${level}>${escapeHtml(heading[2])}</h${level}>`
      }
      return `<p>${escapeHtml(t)}</p>`
    })
    .filter((l) => l !== '')
    .join('\n')
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
