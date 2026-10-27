import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { and, eq, isNull } from "drizzle-orm";
import { agentApiKeys, type Db } from "@paperclipai/db";

/** Header-only authentication; legacy query-token compatibility stays at its caller. */
export async function authenticateAgentKey(db: Db, headers: Pick<IncomingHttpHeaders, "authorization">, companyId?: string) {
  const raw = headers.authorization;
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith("bearer ")) return null;
  const token = raw.slice(7).trim();
  if (!token) return null;
  const keyHash = createHash("sha256").update(token).digest("hex");
  const key = await db.select().from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, keyHash), isNull(agentApiKeys.revokedAt)))
    .then(rows => rows[0] ?? null);
  if (!key || (companyId && key.companyId !== companyId) || key.scopeConfig) return null;
  await db.update(agentApiKeys).set({ lastUsedAt: new Date() }).where(eq(agentApiKeys.id, key.id));
  return key;
}
