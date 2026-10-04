import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, nowIso, type SessionUser } from "./db";
import { hashToken, newToken } from "./password";

type Row = Record<string, any>;

export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get("stweg_session")?.value;
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT u.id, u.organization_id, u.name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), new Date().toISOString()) as Row | undefined;
  if (!row) return null;
  return { id: row.id, organizationId: row.organization_id, name: row.name, email: row.email, role: row.role };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export function createSession(userId: string): { token: string; expires: Date } {
  const token = newToken();
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  getDb()
    .prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), userId, hashToken(token), expires.toISOString(), nowIso());
  return { token, expires };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}
