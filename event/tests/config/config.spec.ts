import { readConfiguration } from '../../src/utils/config.utils';

describe('readConfiguration', () => {
  const keys = [
    'CTP_CLIENT_ID',
    'CTP_CLIENT_SECRET',
    'CTP_PROJECT_KEY',
    'CTP_SCOPE',
    'CTP_REGION',
    'PORT',
    'CONNECT_SUBSCRIPTION_DESTINATION',
    'CONNECT_AWS_TOPIC_ARN',
    'CONNECT_GCP_TOPIC_NAME',
    'CONNECT_GCP_PROJECT_ID',
  ] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.CTP_CLIENT_ID = 'a'.repeat(24);
    process.env.CTP_CLIENT_SECRET = 'b'.repeat(32);
    process.env.CTP_PROJECT_KEY = 'test-project';
    process.env.CTP_SCOPE = 'manage_orders';
    process.env.CTP_REGION = 'us-east-2.aws';
    delete process.env.PORT;
    delete process.env.CONNECT_SUBSCRIPTION_DESTINATION;
    delete process.env.CONNECT_AWS_TOPIC_ARN;
    delete process.env.CONNECT_GCP_TOPIC_NAME;
    delete process.env.CONNECT_GCP_PROJECT_ID;
  });

  afterAll(() => {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('allows all Connect-injected destination variables to be absent', () => {
    expect(() => readConfiguration()).not.toThrow();
  });

  it('defaults PORT to 8080', () => {
    expect(readConfiguration().port).toBe('8080');
  });

  it('respects an explicitly configured PORT', () => {
    process.env.PORT = '9090';
    expect(readConfiguration().port).toBe('9090');
  });
});
