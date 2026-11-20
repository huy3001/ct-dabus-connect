import {
  DabusApiError,
  DabusClient,
  convertKeys,
  readDabusSettings,
} from '../../src/clients/dabus';
import { Order } from '../../src/generated/dabus-client';

const settings = {
  baseUrl: 'https://dabus.example/v1/commercetools/project',
  tokenUrl: 'https://auth.example/token',
  clientId: 'id',
  clientSecret: 'secret',
};

type ReqInit = NonNullable<Parameters<typeof fetch>[1]>;

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

const order = {
  orderNumber: 'order-1',
  customer: { email: 'a@example.com', firstName: 'Ada', lastName: 'Test' },
} as Order;

function fakeFetch(handler: (url: string, init: ReqInit) => Response) {
  const calls: Array<{ url: string; init: ReqInit }> = [];
  const impl = jest.fn(async (input: string | URL, init?: ReqInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('Dabus client', () => {
  it('sends snake_case bodies with a bearer token and reads camelCase', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/token')) return json(200, { access_token: 't' });
      if (url.endsWith('/order/order-1')) return json(404);
      return json(200);
    });
    const client = new DabusClient(settings, impl);
    expect(await client.findOrder('order-1')).toBeUndefined();
    await client.createOrder(order);
    const create = calls.find((c) => c.init.method === 'POST' && c.url.endsWith('/order'));
    expect(create?.url).toBe(`${settings.baseUrl}/order`);
    expect(JSON.parse(String(create?.init.body))).toMatchObject({
      order_number: 'order-1',
      customer: { first_name: 'Ada' },
    });
    expect(create?.init.headers).toMatchObject({ authorization: 'Bearer t' });
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  it('treats a duplicate create as success when the order exists', async () => {
    const { impl } = fakeFetch((url, init) => {
      if (url.endsWith('/token')) return json(200, { access_token: 't' });
      if (init.method === 'POST') return json(409);
      return json(200, { order_number: 'order-1' });
    });
    await expect(new DabusClient(settings, impl).createOrder(order)).resolves.toBeUndefined();
  });

  it('marks 5xx and 429 retryable but 4xx permanent', async () => {
    expect(new DabusApiError('x', 503).retryable).toBe(true);
    expect(new DabusApiError('x', 429).retryable).toBe(true);
    expect(new DabusApiError('x').retryable).toBe(true);
    expect(new DabusApiError('x', 422).retryable).toBe(false);
  });

  it('requires HTTPS except for loopback hosts', () => {
    const base = { DAbUS_CLIENT_ID: 'i', DAbUS_CLIENT_SECRET: 's' };
    expect(() =>
      readDabusSettings({ ...base, DAbUS_BASE_URL: 'http://dabus.example', DAbUS_TOKEN_URL: 'https://a.example' })
    ).toThrow('HTTPS');
    expect(
      readDabusSettings({ ...base, DAbUS_BASE_URL: 'http://127.0.0.1:4000/v1', DAbUS_TOKEN_URL: 'https://a.example' }).baseUrl
    ).toBe('http://127.0.0.1:4000/v1');
  });

  it('converts nested keys', () => {
    expect(convertKeys({ aB: [{ cD: 1 }] }, (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))).toEqual({
      a_b: [{ c_d: 1 }],
    });
  });
});
