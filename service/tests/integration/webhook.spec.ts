import { expect } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app';
import { isAuthorized } from '../../src/controllers/webhook.controller';

jest.mock('../../src/utils/config.utils');
jest.mock('../../src/utils/logger.utils', () => ({
  logger: { info: jest.fn(), error: jest.fn() },
}));

describe('POST /service/webhooks/dabus', () => {
  beforeEach(() => {
    process.env.DABUS_WEBHOOK_SECRET = 'shared-secret';
  });

  test('unknown paths return 404', async () => {
    expect((await request(app).post('/none')).status).toBe(404);
  });

  test('rejects a missing or wrong secret', async () => {
    const body = { order_number: 'o1', status: 'complete' };
    expect((await request(app).post('/service/webhooks/dabus').send(body)).status).toBe(401);
    const wrong = await request(app)
      .post('/service/webhooks/dabus')
      .set('x-dabus-webhook-secret', 'nope')
      .send(body);
    expect(wrong.status).toBe(401);
  });

  test('rejects an invalid payload once authorized', async () => {
    const response = await request(app)
      .post('/service/webhooks/dabus')
      .set('x-dabus-webhook-secret', 'shared-secret')
      .send({ order_number: 'o1', status: 'bogus' });
    expect(response.status).toBe(400);
  });

  test('compares secrets without length leaks', () => {
    expect(isAuthorized('shared-secret', 'shared-secret')).toBe(true);
    expect(isAuthorized('short', 'shared-secret')).toBe(false);
    expect(isAuthorized(undefined, 'shared-secret')).toBe(false);
  });
});
