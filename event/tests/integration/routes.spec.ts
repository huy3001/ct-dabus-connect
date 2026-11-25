import { expect } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app';
import * as enventController from '../../src/controllers/event.controller';
import * as orderSync from '../../src/sync/order-sync';
import { readConfiguration } from '../../src/utils/config.utils';

jest.mock('../../src/utils/config.utils');
describe('Testing router', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    (readConfiguration as jest.Mock).mockClear();
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });
  test('Post to non existing route', async () => {
    const response = await request(app).post('/none');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      message: 'Path not found.',
    });
  });
  test('Post invalid body', async () => {
    const response = await request(app).post('/event').send({
      message: 'hello world',
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: 'Bad request: Unsupported SNS or Pub/Sub message format',
    });
  });
  test('Post empty body', async () => {
    const response = await request(app).post('/event');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: 'Bad request: Unsupported SNS or Pub/Sub message format',
    });
  });
  test('Confirms an AWS SNS subscription', async () => {
    jest.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 200 })
    );
    const response = await request(app).post('/event').send({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.example/confirm',
    });
    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://sns.example/confirm',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
      })
    );
  });
  test('Accepts SNS Notification JSON delivered as text/plain', async () => {
    const parse = jest
      .spyOn(orderSync, 'parseOrderMessage')
      .mockReturnValue(undefined);
    const response = await request(app)
      .post('/event')
      .set('Content-Type', 'text/plain')
      .send(
        JSON.stringify({
          Type: 'Notification',
          Message: JSON.stringify({ notificationType: 'ResourceCreated' }),
        })
      );
    expect(response.status).toBe(204);
    expect(parse).toHaveBeenCalledWith({ notificationType: 'ResourceCreated' });
    parse.mockRestore();
  });
  test('Accepts a Google Cloud Pub/Sub envelope', async () => {
    const parse = jest
      .spyOn(orderSync, 'parseOrderMessage')
      .mockReturnValue(undefined);
    const data = { notificationType: 'ResourceCreated' };
    const response = await request(app)
      .post('/event')
      .send({ message: { data: Buffer.from(JSON.stringify(data)).toString('base64') } });
    expect(response.status).toBe(204);
    expect(parse).toHaveBeenCalledWith(data);
    parse.mockRestore();
  });
});
describe('unexpected error', () => {
  let postMock: jest.SpyInstance;

  beforeEach(() => {
    // Mock the post method to throw an error
    postMock = jest.spyOn(enventController, 'post').mockImplementation(() => {
      throw new Error('Test error');
    });
    (readConfiguration as jest.Mock).mockClear();
  });

  afterEach(() => {
    // Restore the original implementation
    postMock.mockRestore();
  });
  test('should handle errors thrown by post method', async () => {
    // Call the route handler
    const response = await request(app).post('/event');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal server error' });
  });
});
