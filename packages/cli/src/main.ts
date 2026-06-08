#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs'
import type { SqlConnectionProfile } from '@vergis/capabilities'
import { runSpec } from './run'

function arg(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag)
  return i >= 0 ? rest[i + 1] : undefined
}

function loadConnections(path?: string): Record<string, SqlConnectionProfile> | undefined {
  if (!path) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, SqlConnectionProfile>
}

async function main(argv: string[]): Promise<number> {
  const [cmd, specPath, ...rest] = argv
  if (cmd !== 'run' || !specPath) {
    console.error('uso: vergis run <spec.yaml> [--log <path>] [--out <dir>] [--connections <profiles.json>]')
    return 2
  }
  const logPath = arg(rest, '--log') ?? 'vergis.log.jsonl'
  const baseDir = arg(rest, '--out') ?? process.cwd()
  const connections = loadConnections(arg(rest, '--connections'))

  try {
    const outcome = await runSpec({ specPath, logPath, baseDir, connections })
    if (outcome.ok) {
      for (const a of outcome.artifacts) console.log(`✔ ${a.format} → ${a.path}`)
      console.log(`✔ log encadenado: ${outcome.log.length} entradas (cadena ${outcome.chainValid ? 'válida' : 'CORRUPTA'})`)
      return 0
    }
    console.error(
      `✗ Botlet '${outcome.botletId}' degradó a fallback agéntico` +
        (outcome.fallback ? `: ${outcome.fallback.reason} (recovery: ${outcome.fallback.recovery})` : ''),
    )
    return 1
  } catch (e) {
    const structured = (e as { structured?: { code: string; message: string; remediation?: string } })?.structured
    if (structured) {
      console.error(`✗ ${structured.code}: ${structured.message}`)
      if (structured.remediation) console.error(`  remediation: ${structured.remediation}`)
    } else {
      console.error(`✗ error: ${(e as Error)?.message ?? e}`)
    }
    return 1
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code))
