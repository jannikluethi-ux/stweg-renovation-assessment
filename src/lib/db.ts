import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema";
import { resolveDbPath } from "./config";

const globalForDb = globalThis as unknown as { stwegDb?: Database.Database };

export function databasePath(): string {
  return resolveDbPath();
}

export function getDb(): Database.Database {
  if (!globalForDb.stwegDb) {
    const file = databasePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA_SQL);
    globalForDb.stwegDb = db;
  }
  return globalForDb.stwegDb;
}

/** Close and forget the cached connection (used by the test harness). */
export function closeDb(): void {
  if (globalForDb.stwegDb) {
    globalForDb.stwegDb.close();
    globalForDb.stwegDb = undefined;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function writeAudit(
  db: Database.Database,
  entry: {
    organizationId: string;
    userId: string | null;
    entity: string;
    entityId: string;
    action: string;
    previousValue?: unknown;
    newValue?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO audit_logs (id, organization_id, user_id, entity, entity_id, action, timestamp, previous_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cryptoRandom(),
    entry.organizationId,
    entry.userId,
    entry.entity,
    entry.entityId,
    entry.action,
    nowIso(),
    entry.previousValue == null ? null : JSON.stringify(entry.previousValue).slice(0, 8000),
    entry.newValue == null ? null : JSON.stringify(entry.newValue).slice(0, 8000),
  );
}

function cryptoRandom(): string {
  return globalThis.crypto.randomUUID();
}

export type Role = "project_manager" | "admin";

export interface SessionUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: Role;
}

export function canEditGlobalAssumptions(role: Role): boolean {
  return role === "admin";
}
