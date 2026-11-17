import { EventBus, Injector, Logger, RequestContext } from '@vendure/core';
import fs from 'fs';
import path from 'path';
import type { Subscription } from 'rxjs';

import { loggerCtx } from '../constants';
import { EInvoiceDeliveryRequestedEvent } from '../events';
import type { EInvoiceDeliveryService } from '../services/delivery.service';

import { DeliveryInput, InvoiceDeliveryStrategy } from './types';

/**
 * Attempts of one email in the EmailPlugin: it queues every email with `retries: 5`, and a Vendure job runs once
 * plus once per retry.
 */
export const EMAIL_PLUGIN_ATTEMPTS = 6;

/** Name of the template directory, i.e. the `type` of `eInvoiceDeliveryHandler`. */
export const DELIVERY_EMAIL_TYPE = 'e-invoice-delivery';

type EmailPluginModule = typeof import('@vendure/email-plugin');

/**
 * Default delivery: sends the documents through the Vendure EmailPlugin. Add `eInvoiceDeliveryHandler`
 * (from `@openrootz/vendure-plugin-e-invoice/email`) to the EmailPlugin's handlers and copy the template
 * `templates/e-invoice-delivery/` of this package into your email template directory.
 *
 * `deliver` publishes {@link EInvoiceDeliveryRequestedEvent}; the handler builds the email and the EmailPlugin
 * queues it. The status comes from the EmailPlugin's `EmailSendEvent`, published after every attempt: a failure
 * sets `retrying`, the {@link EMAIL_PLUGIN_ATTEMPTS}th failure `failed`.
 *
 * `@vendure/email-plugin` is an optional peer dependency and only loaded here, at startup.
 *
 * @category Strategies
 */
export class EmailPluginDeliveryStrategy implements InvoiceDeliveryStrategy {
  private eventBus: EventBus;
  private subscription?: Subscription;
  private emailPlugin?: EmailPluginModule;

  /** @internal */
  async init(injector: Injector) {
    this.eventBus = injector.get(EventBus);
    this.emailPlugin = loadEmailPlugin();
    if (!this.emailPlugin) return;
    // Imported here: the service module imports the plugin options, which import this strategy
    const { EInvoiceDeliveryService } = await import('../services/delivery.service');
    const deliveries: EInvoiceDeliveryService = injector.get(EInvoiceDeliveryService);
    this.subscription = this.eventBus.ofType(this.emailPlugin.EmailSendEvent).subscribe((event) => {
      const deliveryId = event.metadata?.eInvoiceDeliveryId;
      if (deliveryId === undefined || deliveryId === null) return;
      deliveries
        .recordAttempt(event.ctx, deliveryId, {
          success: event.success,
          error: event.error instanceof Error ? event.error.message : event.error ? String(event.error) : undefined,
          // The EmailPlugin gives up after the last retry; it does not say which attempt this was
          maxAttempts: EMAIL_PLUGIN_ATTEMPTS,
        })
        .catch((e) => Logger.error(`Could not update e-invoice delivery ${deliveryId}: ${e}`, loggerCtx));
    });
  }

  /** @internal */
  destroy() {
    this.subscription?.unsubscribe();
  }

  async deliver(ctx: RequestContext, input: DeliveryInput): Promise<void> {
    if (!this.emailPlugin) throw new Error('@vendure/email-plugin is not installed');
    await this.eventBus.publish(new EInvoiceDeliveryRequestedEvent(ctx, input.delivery, input.invoice));
  }

  setupIssues(): string[] {
    const mod = this.emailPlugin;
    if (!mod) return ['@vendure/email-plugin is not installed: install it, or configure another `delivery.strategy`'];
    const options = (mod.EmailPlugin as unknown as { options?: { handlers?: { event: unknown }[]; templateLoader?: unknown } }).options;
    if (!options) return ['the EmailPlugin is not configured (EmailPlugin.init)'];
    const issues: string[] = [];
    if (!options.handlers?.some((h) => h.event === EInvoiceDeliveryRequestedEvent)) {
      issues.push(
        'eInvoiceDeliveryHandler is not registered: add it to EmailPlugin.init({ handlers: [...defaultEmailHandlers, eInvoiceDeliveryHandler] }); deliveries stay queued',
      );
    }
    const loader = options.templateLoader;
    const templatePath =
      loader instanceof mod.FileBasedTemplateLoader ? (loader as unknown as { templatePath?: string }).templatePath : undefined;
    if (templatePath && !fs.existsSync(path.join(templatePath, DELIVERY_EMAIL_TYPE, 'body.hbs'))) {
      issues.push(
        `the email template is missing: copy node_modules/@openrootz/vendure-plugin-e-invoice/templates/${DELIVERY_EMAIL_TYPE} to ${templatePath}`,
      );
    }
    return issues;
  }
}

function loadEmailPlugin(): EmailPluginModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@vendure/email-plugin') as EmailPluginModule;
  } catch {
    return undefined;
  }
}
