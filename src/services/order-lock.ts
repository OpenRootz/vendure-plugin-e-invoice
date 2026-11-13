import { ID, Order, RequestContext, TransactionalConnection } from '@vendure/core';

import { EInvoice } from '../entities';

/**
 * Locks the order row for the rest of the transaction, so everything that issues or credits documents for one
 * order is serialized.
 *
 * No-op on SQLite / sql.js, which have no row locks. There, TypeORM runs every transaction on one shared connection
 * and nests concurrent ones as savepoints, so they are not isolated: an admin mutation that runs at the same time
 * as a job for the same order can compute the same document position or sequence value and then fails on the unique
 * index (a job is retried). The e-invoice jobs themselves run one after the other (queue concurrency 1 by default).
 * Use SQLite for development only.
 */
export function lockOrder(connection: TransactionalConnection, ctx: RequestContext, orderId: ID): Promise<Order | null> {
  const qb = connection
    .getRepository(ctx, Order)
    .createQueryBuilder('locked_order')
    .innerJoin('locked_order.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
    .where('locked_order.id = :orderId', { orderId });
  if (supportsRowLocks(connection)) qb.setLock('pessimistic_write', undefined, ['locked_order']);
  return qb.getOne();
}

export function supportsRowLocks(connection: TransactionalConnection): boolean {
  const type = connection.rawConnection.options.type;
  return type !== 'sqljs' && type !== 'sqlite' && type !== 'better-sqlite3';
}

/**
 * Position of the next document of the order (`EInvoice.position`). Call it inside the transaction that holds the
 * order lock (`lockOrder`), so that two documents cannot get the same position.
 */
export async function nextDocumentPosition(connection: TransactionalConnection, ctx: RequestContext, orderId: ID): Promise<number> {
  const row = await connection
    .getRepository(ctx, EInvoice)
    .createQueryBuilder('doc')
    .select('MAX(doc.position)', 'max')
    .where('doc.orderId = :orderId', { orderId })
    .getRawOne<{ max: number | string | null }>();
  return Number(row?.max ?? 0) + 1;
}
