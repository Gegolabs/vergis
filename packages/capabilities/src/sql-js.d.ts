// Declaración mínima de sql.js (SQLite/WASM) — solo la superficie que usamos.
declare module 'sql.js' {
  interface Statement {
    bind(values: unknown[]): void
    step(): boolean
    getAsObject(): Record<string, unknown>
    reset(): void
    free(): void
  }
  interface Database {
    run(sql: string, params?: unknown[]): void
    exec(sql: string): { columns: string[]; values: unknown[][] }[]
    prepare(sql: string): Statement
    export(): Uint8Array
    close(): void
  }
  interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database
  }
  interface InitOptions {
    locateFile?: (file: string) => string
  }
  export default function initSqlJs(opts?: InitOptions): Promise<SqlJsStatic>
}
