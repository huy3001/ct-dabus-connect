import type {
  Customer,
  Order,
  OrderUpdateAction,
} from '@commercetools/platform-sdk';
import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { DabusApiError, type DabusClient } from '../clients/dabus';
import { mapOrder } from '../mappers/orderMapper';
import { logger } from '../utils/logger.utils';

export const CUSTOM_TYPE_KEY = 'dabus-order-sync-metadata';
export const ORDER_SUBSCRIPTION_KEY = 'dabus-order-sync-subscription';
export const LAST_UPDATED_BY = 'lastUpdatedBy';
export const SYNC_STATUS = 'dabusSyncStatus';

export type SyncOutcome = 'synced' | 'skipped' | 'failed';

export interface OrderMessage {
  type: 'OrderCreated' | 'OrderStateChanged';
  orderId: string;
  order?: Order;
}

export interface SyncDependencies {
  apiRoot: ByProjectKeyRequestBuilder;
  dabus: DabusClient;
  orderOrigin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns undefined for notifications that need no processing. */
export function parseOrderMessage(data: unknown): OrderMessage | undefined {
  if (!isRecord(data) || typeof data.type !== 'string') return undefined;
  if (data.type !== 'OrderCreated' && data.type !== 'OrderStateChanged') {
    return undefined;
  }
  const resource = data.resource;
  if (!isRecord(resource) || typeof resource.id !== 'string') return undefined;
  return {
    type: data.type,
    orderId: resource.id,
    order: isRecord(data.order) ? (data.order as unknown as Order) : undefined,
  };
}

async function writeCustomFields(
  apiRoot: ByProjectKeyRequestBuilder,
  orderId: string,
  fields: Record<string, string>
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { body: current } = await apiRoot
      .orders()
      .withId({ ID: orderId })
      .get()
      .execute();
    const actions: OrderUpdateAction[] = current.custom
      ? Object.entries(fields).map(([name, value]) => ({
          action: 'setCustomField',
          name,
          value,
        }))
      : [
          {
            action: 'setCustomType',
            type: { typeId: 'type', key: CUSTOM_TYPE_KEY },
            fields,
          },
        ];
    try {
      await apiRoot
        .orders()
        .withId({ ID: orderId })
        .post({ body: { version: current.version, actions } })
        .execute();
      return;
    } catch (error) {
      const status = isRecord(error) ? error.statusCode : undefined;
      if (status !== 409 || attempt >= 3) throw error;
    }
  }
}

async function loadCustomer(
  apiRoot: ByProjectKeyRequestBuilder,
  customerId: string | undefined
): Promise<Customer | undefined> {
  if (!customerId) return undefined;
  try {
    const { body } = await apiRoot
      .customers()
      .withId({ ID: customerId })
      .get()
      .execute();
    return body;
  } catch (error) {
    if (isRecord(error) && error.statusCode === 404) return undefined;
    throw error;
  }
}

/**
 * Syncs one commercetools order to DaBus.
 * Permanent failures are recorded on the order and resolve to "failed";
 * transient failures are thrown so the message is redelivered.
 */
export async function syncOrder(
  message: OrderMessage,
  { apiRoot, dabus, orderOrigin }: SyncDependencies
): Promise<SyncOutcome> {
  // Both event types are processed from the latest resource state. Subscription
  // payloads can omit data or become stale before a redelivered event is handled.
  const order = (
    await apiRoot.orders().withId({ ID: message.orderId }).get().execute()
  ).body;

  if (order.custom?.fields?.[LAST_UPDATED_BY] === 'dabus') {
    logger.info(`Skipping order ${order.id}: last updated by DaBus`);
    // Consume the flag so a later commercetools-originated change is synced.
    await writeCustomFields(apiRoot, order.id, {
      [LAST_UPDATED_BY]: 'commercetools',
    });
    return 'skipped';
  }

  try {
    const customer = await loadCustomer(apiRoot, order.customerId);
    const dabusOrder = mapOrder(order, customer, orderOrigin);
    const existing = await dabus.findOrder(dabusOrder.orderNumber);
    if (existing) {
      await dabus.updateOrder(dabusOrder);
    } else {
      await dabus.createOrder(dabusOrder);
    }
  } catch (error) {
    if (error instanceof DabusApiError && error.retryable) throw error;
    logger.error(`Order ${order.id} cannot be synced: ${String(error)}`);
    await writeCustomFields(apiRoot, order.id, {
      [LAST_UPDATED_BY]: 'commercetools',
      [SYNC_STATUS]: 'FAILED',
    });
    return 'failed';
  }

  await writeCustomFields(apiRoot, order.id, {
    [LAST_UPDATED_BY]: 'commercetools',
    [SYNC_STATUS]: 'SYNCED',
  });
  return 'synced';
}
