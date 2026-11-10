import { Inject, Injectable } from '@nestjs/common';
import { RequestContext, TransactionalConnection } from '@vendure/core';

import { PLUGIN_INIT_OPTIONS } from '../constants';
import { EInvoiceSequence } from '../entities';
import { ResolvedEInvoicePluginOptions } from '../options';
import { NumberInput } from '../strategies/types';

import { supportsRowLocks } from './order-lock';

export interface ReservedNumber {
  key: string;
  value: number;
  number: string;
}

/**
 * Gap-free invoice numbers.
 *
 * Must be called inside the transaction that also saves the invoice: the counter row stays locked until
 * that transaction commits, so concurrent issues wait for each other, and a rollback also rolls back the counter.
 */
@Injectable()
export class InvoiceNumberService {
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
  ) {}

  async reserve(ctx: RequestContext, input: NumberInput): Promise<ReservedNumber> {
    const strategy = this.options.numberStrategy;
    const key = await strategy.sequenceKey(ctx, input);
    const repo = this.connection.getRepository(ctx, EInvoiceSequence);

    await repo.createQueryBuilder().insert().into(EInvoiceSequence).values({ key, lastValue: 0 }).orIgnore().execute();
    const sequence = await repo.findOneOrFail({
      where: { key },
      // SQLite / sql.js serialize write transactions anyway and do not support row locks
      lock: supportsRowLocks(this.connection) ? { mode: 'pessimistic_write' } : undefined,
    });
    const value = sequence.lastValue + 1;
    await repo.update({ id: sequence.id }, { lastValue: value });
    return { key, value, number: strategy.format(ctx, { ...input, value }) };
  }
}
