import { Request, Response } from 'express';
import { createApiRoot } from '../clients/commercetools';
import { getDabusClient } from '../clients/dabus';
import CustomError from '../errors/custom.error';
import { parseOrderMessage, syncOrder } from '../sync/order-sync';
import { logger } from '../utils/logger.utils';

/**
 * Receives AWS SNS or Google Cloud Pub/Sub push messages carrying an Order
 * message. Valid and intentionally skipped messages are acknowledged; only
 * transient failures answer 500 so the delivery service redelivers.
 */
export const post = async (request: Request, response: Response) => {
  if (
    request.body?.Type === 'SubscriptionConfirmation' &&
    typeof request.body?.SubscribeURL === 'string'
  ) {
    logger.info('Confirming AWS SNS subscription');
    try {
      const confirmation = await fetch(request.body.SubscribeURL, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!confirmation.ok) {
        throw new Error(
          `AWS SNS confirmation endpoint returned ${confirmation.status}`
        );
      }
    } catch (error) {
      logger.error(`AWS SNS subscription confirmation failed: ${String(error)}`);
      throw new CustomError(
        500,
        'AWS SNS subscription confirmation failed; notification will be retried'
      );
    }
    response.status(200).send();
    return;
  }

  let data: unknown;
  if (typeof request.body?.Message === 'string') {
    try {
      data = JSON.parse(request.body.Message);
    } catch {
      throw new CustomError(400, 'Bad request: SNS Message is not valid JSON');
    }
  } else if (typeof request.body?.message?.data === 'string') {
    try {
      data = JSON.parse(
        Buffer.from(request.body.message.data, 'base64').toString('utf-8')
      );
    } catch {
      throw new CustomError(400, 'Bad request: Pub/Sub data is not valid JSON');
    }
  } else {
    logger.error('Missing or unsupported SNS/Pub/Sub message envelope');
    throw new CustomError(
      400,
      'Bad request: Unsupported SNS or Pub/Sub message format'
    );
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
