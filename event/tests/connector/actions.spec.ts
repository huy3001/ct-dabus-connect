import { createOrderSubscription } from '../../src/connector/actions';
import type { Config } from '../../src/interfaces/config.interface';

jest.mock('../../src/utils/logger.utils', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

function createApiRoot() {
  const post = jest.fn(() => ({
    execute: jest.fn(async () => undefined),
  }));
  const apiRoot = {
    subscriptions: () => ({
      get: () => ({
        execute: jest.fn(async () => ({ body: { results: [] } })),
      }),
      post,
    }),
  };
  return { apiRoot: apiRoot as never, post };
}

const baseConfig: Config = {
  clientId: 'id',
  clientSecret: 'secret',
  projectKey: 'project',
  scope: 'manage_orders',
  region: 'us-east-2.aws',
  port: '8080',
};

describe('createOrderSubscription', () => {
  const originalAwsTopicArn = process.env.CONNECT_AWS_TOPIC_ARN;
  const originalGcpTopicName = process.env.CONNECT_GCP_TOPIC_NAME;
  const originalGcpProjectId = process.env.CONNECT_GCP_PROJECT_ID;

  afterEach(() => {
    if (originalAwsTopicArn === undefined) {
      delete process.env.CONNECT_AWS_TOPIC_ARN;
    } else {
      process.env.CONNECT_AWS_TOPIC_ARN = originalAwsTopicArn;
    }
    if (originalGcpTopicName === undefined) {
      delete process.env.CONNECT_GCP_TOPIC_NAME;
    } else {
      process.env.CONNECT_GCP_TOPIC_NAME = originalGcpTopicName;
    }
    if (originalGcpProjectId === undefined) {
      delete process.env.CONNECT_GCP_PROJECT_ID;
    } else {
      process.env.CONNECT_GCP_PROJECT_ID = originalGcpProjectId;
    }
  });

  it('prefers the AWS topic ARN injected by Connect', async () => {
    process.env.CONNECT_AWS_TOPIC_ARN = 'arn:aws:sns:us-east-2:123:orders';
    delete process.env.CONNECT_GCP_TOPIC_NAME;
    delete process.env.CONNECT_GCP_PROJECT_ID;
    const { apiRoot, post } = createApiRoot();

    await createOrderSubscription(apiRoot, baseConfig);

    expect(post).toHaveBeenCalledWith({
      body: expect.objectContaining({
        destination: {
          type: 'SNS',
          topicArn: 'arn:aws:sns:us-east-2:123:orders',
          authenticationMode: 'IAM',
        },
      }),
    });
  });

  it('uses the GCP topic variables when no AWS topic is injected', async () => {
    delete process.env.CONNECT_AWS_TOPIC_ARN;
    process.env.CONNECT_GCP_TOPIC_NAME = 'order-events';
    process.env.CONNECT_GCP_PROJECT_ID = 'gcp-project';
    const { apiRoot, post } = createApiRoot();

    await createOrderSubscription(apiRoot, baseConfig);

    expect(post).toHaveBeenCalledWith({
      body: expect.objectContaining({
        destination: {
          type: 'GoogleCloudPubSub',
          topic: 'order-events',
          projectId: 'gcp-project',
        },
      }),
    });
  });

  it('skips GCP subscription creation for local development', async () => {
    delete process.env.CONNECT_AWS_TOPIC_ARN;
    const { apiRoot, post } = createApiRoot();

    await createOrderSubscription(apiRoot, {
      ...baseConfig,
      connectGcpTopicName: 'order-events',
      connectGcpProjectId: 'local-dev-project',
    });

    expect(post).not.toHaveBeenCalled();
  });

  it('throws when Connect injects no destination', async () => {
    delete process.env.CONNECT_AWS_TOPIC_ARN;
    delete process.env.CONNECT_GCP_TOPIC_NAME;
    delete process.env.CONNECT_GCP_PROJECT_ID;
    const { apiRoot } = createApiRoot();

    await expect(createOrderSubscription(apiRoot, baseConfig)).rejects.toThrow(
      'did not inject'
    );
  });
});
