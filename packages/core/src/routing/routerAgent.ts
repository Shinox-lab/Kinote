import { and, asc, eq } from 'drizzle-orm';
import { agents, type DbTransaction } from '@living-wiki/db';

/** Who created the built-in Routing engine: nobody, the system. */
const SYSTEM_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The tenant's built-in Routing engine agent, created on first use. Every
 * engine edit is made as this agent on behalf of the capture's sender (R8).
 */
export async function ensureRouterAgent(tx: DbTransaction, tenantId: string): Promise<string> {
  const find = async () =>
    (
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.tenantId, tenantId), eq(agents.kind, 'router')))
        .orderBy(asc(agents.createdAt))
        .limit(1)
    )[0]?.id;
  const existing = await find();
  if (existing) return existing;
  const [row] = await tx
    .insert(agents)
    .values({ tenantId, name: 'Routing engine', kind: 'router', createdBy: SYSTEM_ID })
    .returning({ id: agents.id });
  return row!.id;
}
