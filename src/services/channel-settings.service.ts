import { Injectable } from '@nestjs/common';
import { RequestContext, TransactionalConnection } from '@vendure/core';

import { EInvoiceChannelSettings, LayoutSettings, PaymentSettings, SellerSettings } from '../entities';

export interface UpdateChannelSettingsInput {
  enabled?: boolean;
  autoIssue?: boolean;
  seller?: SellerSettings;
  payment?: PaymentSettings;
  layout?: LayoutSettings;
}

@Injectable()
export class ChannelSettingsService {
  constructor(private connection: TransactionalConnection) {}

  /** Settings of the current channel; an unsaved default (disabled) when none exist yet. */
  async get(ctx: RequestContext): Promise<EInvoiceChannelSettings> {
    const existing = await this.connection
      .getRepository(ctx, EInvoiceChannelSettings)
      .findOne({ where: { channelId: ctx.channelId } });
    return (
      existing ??
      new EInvoiceChannelSettings({ channelId: ctx.channelId, enabled: false, autoIssue: true, seller: {}, payment: {}, layout: {} })
    );
  }

  async update(ctx: RequestContext, input: UpdateChannelSettingsInput): Promise<EInvoiceChannelSettings> {
    const settings = await this.get(ctx);
    if (input.enabled !== undefined && input.enabled !== null) settings.enabled = input.enabled;
    if (input.autoIssue !== undefined && input.autoIssue !== null) settings.autoIssue = input.autoIssue;
    if (input.seller) settings.seller = input.seller;
    if (input.payment) settings.payment = input.payment;
    if (input.layout) settings.layout = input.layout;
    return this.connection.getRepository(ctx, EInvoiceChannelSettings).save(settings);
  }
}
