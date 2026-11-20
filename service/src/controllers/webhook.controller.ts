import { createHash, timingSafeEqual } from 'node:crypto';
import { Request, Response } from 'express';
import type { OrderUpdateAction } from '@commercetools/platform-sdk';
import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { createApiRoot } from '../clients/commercetools';
import CustomError from '../errors/custom.error';
import { logger } from '../utils/logger.utils';

export const CUSTOM_TYPE_KEY = 'dabus-order-sync-metadata';
export const WEBHOOK_SECRET_HEADER = 'x-dabus-webhook-secret';

// Dabus statuses without an entry have no commercetools order state equivalent.
const ORDER_STATE_BY_STATUS: Record<string, 'Open' | 'Confirmed' | 'Complete' | 'Cancelled'> = {
  pending: 'Open',
  processing: 'Confirmed',
  complete: 'Complete',
  canceled: 'Cancelled',
};

const KNOWN_STATUSES = [
  'canceled',
  'closed',
  'complete',
  'holded',
  'pending',
  'processing',
  'shipped',
  'returned',
];

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function isAuthorized(header: unknown, secret: string): boolean {
  return typeof header === 'string' && timingSafeEqual(digest(header), digest(secret));
}

interface WebhookPayload {
  order_number: string;
  status: string;
}

function parsePayload(body: unknown): WebhookPayload {
  if (typeof body === 'object' && body !== null) {
    const { order_number: orderNumber, status } = body as Record<string, unknown>;
    if (
      typeof orderNumber === 'string' &&
      orderNumber.length > 0 &&
      typeof status === 'string' &&
      KNOWN_STATUSES.includes(status)
    ) {
      return { order_number: orderNumber, status };
    }
  }
  throw new CustomError(
    400,
    'Bad request: expected order_number and a valid Dabus order status'
  );
}

async function applyStatus(
  apiRoot: ByProjectKeyRequestBuilder,
  { order_number: orderNumber, status }: WebhookPayload
): Promise<'updated' | 'unchanged' | 'not-found'> {
  const targetState = ORDER_STATE_BY_STATUS[status];

  for (let attempt = 1; ; attempt++) {
    let order;
    try {
      ({ body: order } = await apiRoot
        .orders()
        .withOrderNumber({ orderNumber })
        .get()
        .execute());
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return 'not-found';
      throw error;
    }

    // Writing nothing keeps lastUpdatedBy from suppressing the next commercetools change.
    if (!targetState || order.orderState === targetState) return 'unchanged';

    const fields = { lastUpdatedBy: 'dabus', dabusSyncStatus: 'SYNCED' };
    const actions: OrderUpdateAction[] = [
      { action: 'changeOrderState', orderState: targetState },
      ...(order.custom
        ? Object.entries(fields).map(([name, value]) => ({
            action: 'setCustomField' as const,
            name,
            value,
          }))
        : [
            {
              action: 'setCustomType' as const,
              type: { typeId: 'type' as const, key: CUSTOM_TYPE_KEY },
              fields,
            },
          ]),
    ];
    try {
      await apiRoot
        .orders()
        .withOrderNumber({ orderNumber })
        .post({ body: { version: order.version, actions } })
        .execute();
      return 'updated';
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409 || attempt >= 3) {
        throw error;
      }
    }
  }
}

/** POST /service/webhooks/dabus */
export const post = async (request: Request, response: Response) => {
  const secret = process.env.DABUS_WEBHOOK_SECRET;
  if (!secret) {
    throw new CustomError(500, 'DABUS_WEBHOOK_SECRET is not configured');
  }
  if (!isAuthorized(request.header(WEBHOOK_SECRET_HEADER), secret)) {
    throw new CustomError(401, 'Unauthorized');
  }

  const payload = parsePayload(request.body);
  const outcome = await applyStatus(createApiRoot(), payload);
  logger.info(`Dabus webhook for order ${payload.order_number}: ${outcome}`);

  if (outcome === 'not-found') {
    throw new CustomError(404, 'Order not found');
  }
  response.status(204).send();
};
