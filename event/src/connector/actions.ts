import type { FieldDefinition } from '@commercetools/platform-sdk';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { Config } from '../interfaces/config.interface';
import {
  CUSTOM_TYPE_KEY,
  ORDER_SUBSCRIPTION_KEY,
  LAST_UPDATED_BY,
  SYNC_STATUS,
} from '../sync/order-sync';
import { logger } from '../utils/logger.utils';

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    name: LAST_UPDATED_BY,
    label: { en: 'Last updated by' },
    required: false,
    type: { name: 'String' },
    inputHint: 'SingleLine',
  },
  {
    name: SYNC_STATUS,
    label: { en: 'Dabus sync status' },
    required: false,
    type: { name: 'String' },
    inputHint: 'SingleLine',
  },
];

export async function ensureOrderSyncCustomType(
  apiRoot: ByProjectKeyRequestBuilder
): Promise<void> {
  logger.info(`Ensuring DaBus Order custom type "${CUSTOM_TYPE_KEY}" exists`);
  const {
    body: { results },
  } = await apiRoot
    .types()
    .get({ queryArgs: { where: `key = "${CUSTOM_TYPE_KEY}"` } })
    .execute();

  if (results.length === 0) {
    logger.info(`Creating DaBus Order custom type "${CUSTOM_TYPE_KEY}"`);
    await apiRoot
      .types()
      .post({
        body: {
          key: CUSTOM_TYPE_KEY,
          name: { en: 'Dabus order sync metadata' },
          resourceTypeIds: ['order'],
          fieldDefinitions: FIELD_DEFINITIONS,
        },
      })
      .execute();
    logger.info(`Created DaBus Order custom type "${CUSTOM_TYPE_KEY}"`);
    return;
  }

  logger.info(`DaBus Order custom type "${CUSTOM_TYPE_KEY}" already exists`);
  const type = results[0];
  const present = new Set(type.fieldDefinitions.map((field) => field.name));
  const missing = FIELD_DEFINITIONS.filter((field) => !present.has(field.name));
  if (missing.length === 0) {
    logger.info(`DaBus Order custom type "${CUSTOM_TYPE_KEY}" is up to date`);
    return;
  }
  logger.info(
    `Adding ${missing.length} missing field(s) to DaBus Order custom type "${CUSTOM_TYPE_KEY}"`
  );
  await apiRoot
    .types()
    .withKey({ key: CUSTOM_TYPE_KEY })
    .post({
      body: {
        version: type.version,
        actions: missing.map((fieldDefinition) => ({
          action: 'addFieldDefinition',
          fieldDefinition,
        })),
      },
    })
    .execute();
  logger.info(`Updated DaBus Order custom type "${CUSTOM_TYPE_KEY}"`);
}

async function deleteOrderSubscription(
  apiRoot: ByProjectKeyRequestBuilder
): Promise<void> {
  const {
    body: { results },
  } = await apiRoot
    .subscriptions()
    .get({ queryArgs: { where: `key = "${ORDER_SUBSCRIPTION_KEY}"` } })
    .execute();

  if (results.length > 0) {
    await apiRoot
      .subscriptions()
      .withKey({ key: ORDER_SUBSCRIPTION_KEY })
      .delete({ queryArgs: { version: results[0].version } })
      .execute();
  }
}

const ORDER_MESSAGES = [
  {
    resourceTypeId: 'order',
    types: ['OrderCreated', 'OrderStateChanged'],
  },
];

export async function createOrderSubscription(
  apiRoot: ByProjectKeyRequestBuilder,
  config: Config
): Promise<void> {
  const topicArn = config.connectAwsTopicArn;
  const gcpTopicName = config.connectGcpTopicName;
  const gcpProjectId = config.connectGcpProjectId;

  if (topicArn) {
    logger.info(
      `Detected AWS SNS destination; creating Order Subscription "${ORDER_SUBSCRIPTION_KEY}"`
    );
    await deleteOrderSubscription(apiRoot);
    await apiRoot
      .subscriptions()
      .post({
        body: {
          key: ORDER_SUBSCRIPTION_KEY,
          destination: {
            type: 'SNS',
            topicArn,
            authenticationMode: 'IAM',
          },
          messages: ORDER_MESSAGES,
        },
      })
      .execute();
    logger.info(
      `Created AWS SNS Order Subscription "${ORDER_SUBSCRIPTION_KEY}"`
    );
    return;
  }

  if (gcpTopicName && gcpProjectId) {
    if (gcpProjectId === 'local-dev-project') {
      logger.warn(
        'CONNECT_GCP_PROJECT_ID is "local-dev-project"; skipping Order Subscription creation for local development'
      );
      return;
    }
    logger.info(
      `Detected GCP Pub/Sub destination; creating Order Subscription "${ORDER_SUBSCRIPTION_KEY}"`
    );
    await deleteOrderSubscription(apiRoot);
    await apiRoot
      .subscriptions()
      .post({
        body: {
          key: ORDER_SUBSCRIPTION_KEY,
          destination: {
            type: 'GoogleCloudPubSub',
            topic: gcpTopicName,
            projectId: gcpProjectId,
          },
          messages: ORDER_MESSAGES,
        },
      })
      .execute();
    logger.info(
      `Created GCP Pub/Sub Order Subscription "${ORDER_SUBSCRIPTION_KEY}"`
    );
    return;
  }

  throw new Error(
    'Cannot create Order Subscription: Connect did not inject an AWS SNS topic ARN or a complete GCP Pub/Sub topic/project pair'
  );
}

// The custom type is intentionally kept so existing orders keep their metadata.
export const removeOrderSubscription = deleteOrderSubscription;
