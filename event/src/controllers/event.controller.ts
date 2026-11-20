import { Request, Response } from 'express';
import { createApiRoot } from '../clients/commercetools';
import { getDabusClient } from '../clients/dabus';
import CustomError from '../errors/custom.error';
import { parseOrderMessage, syncOrder } from '../sync/order-sync';
import { logger } from '../utils/logger.utils';

/**
 * Receives a Google Cloud Pub/Sub push message carrying an Order message.
 * Valid and intentionally skipped messages are acknowledged; only transient
 * failures answer 500 so Pub/Sub redelivers with backoff.
 */
export const post = async (request: Request, response: Response) => {
  if (!request.body) {
    logger.error('Missing request body.');
    throw new CustomError(400, 'Bad request: No Pub/Sub message was received');
  }
  const pubSubMessage = request.body.message;
  if (!pubSubMessage) {
    logger.error('Missing body message');
    throw new CustomError(400, 'Bad request: Wrong No Pub/Sub message format');
  }
  if (!pubSubMessage.data) {
    throw new CustomError(400, 'Bad request: Pub/Sub message has no data');
  }

  let data: unknown;
  try {
    data = JSON.parse(
      Buffer.from(pubSubMessage.data, 'base64').toString('utf-8')
    );
  } catch {
    throw new CustomError(400, 'Bad request: Pub/Sub data is not valid JSON');
  }

  const message = parseOrderMessage(data);
  if (!message) {
    // Includes the ResourceCreated notification sent when the subscription is created.
    logger.info('Ignoring message that is not an order change');
    response.status(204).send();
    return;
  }

  const orderOrigin = process.env.DABUS_ORDER_ORIGIN;
  if (!orderOrigin) {
    throw new CustomError(500, 'DABUS_ORDER_ORIGIN is not configured');
  }

  try {
    const outcome = await syncOrder(message, {
      apiRoot: createApiRoot(),
      dabus: getDabusClient(),
      orderOrigin,
    });
    logger.info(`Order ${message.orderId} sync outcome: ${outcome}`);
  } catch (error) {
    logger.error(`Order ${message.orderId} sync failed: ${String(error)}`);
    throw new CustomError(500, 'Order sync failed; message will be retried');
  }

  response.status(204).send();
};
