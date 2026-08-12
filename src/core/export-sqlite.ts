import type { Db } from "./db";
import type { ExportSnapshot, ExportValue } from "./export-generator";

const DERIVED_OR_INTERNAL = /(?:^|_)fts(?:_|$)|(?:^|_)embedding$/u;

/** SQLite adapter. Hosted Postgres supplies the same snapshot contract separately. */
export function collectSqliteExport(db: Db, generatedAt = new Date().toISOString()): ExportSnapshot {
  return db.transaction(() => {
    const names = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
      .filter((name) => safeTableName(name) && !DERIVED_OR_INTERNAL.test(name));

    const tables: ExportSnapshot["tables"] = {};
    for (const name of names) {
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
      tables[name] = rows.map((row) => normalizeRow(row));
    }
    const snapshot: ExportSnapshot = {
      format: "zeus-data-export",
      version: 1,
      generatedAt,
      tables,
    };
    return snapshot;
  })();
}

function safeTableName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/u.test(name);
}

function normalizeRow(row: Record<string, unknown>): Record<string, ExportValue> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  );
}

function normalizeValue(value: unknown): ExportValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Buffer.isBuffer(value)) return { encoding: "base64", value: value.toString("base64") };
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
  }
  return String(value);
}
