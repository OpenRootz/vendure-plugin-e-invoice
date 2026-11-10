import { ID, Order, RequestContext, TransactionalConnection } from '@vendure/core';

/**
 * Locks the order row for the rest of the transaction, so everything that issues or credits documents for one
 * order is serialized. No-op on SQLite / sql.js, which serialize write transactions anyway.
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
