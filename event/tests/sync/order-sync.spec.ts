import type { Order } from '@commercetools/platform-sdk';
import { DabusApiError } from '../../src/clients/dabus';
import { parseOrderMessage, syncOrder } from '../../src/sync/order-sync';

jest.mock('../../src/utils/logger.utils', () => ({
  logger: { info: jest.fn(), error: jest.fn() },
}));

const money = (centAmount: number) => ({
  type: 'centPrecision' as const,
  currencyCode: 'AUD',
  centAmount,
  fractionDigits: 2,
});

function makeOrder(custom?: Record<string, string>): Order {
  return {
    id: 'o1',
    version: 3,
    orderNumber: 'order-1',
    orderState: 'Open',
    createdAt: '2026-11-16T00:00:00.000Z',
    customerEmail: 'a@example.com',
    locale: 'en-AU',
    billingAddress: { firstName: 'Ada', lastName: 'Test', streetName: 'Main', country: 'AU' },
    customLineItems: [],
    taxedPrice: { totalGross: money(1100) },
    lineItems: [{
      variant: { sku: 'sku-1' },
      name: { 'en-AU': 'Item' },
      quantity: 1,
      taxedPrice: { totalNet: money(1000), totalGross: money(1100) },
    }],
    ...(custom && { custom: { type: { typeId: 'type', id: 't' }, fields: custom } }),
  } as unknown as Order;
}

function setup(order: Order) {
  const post = jest.fn(() => ({ execute: async () => ({}) }));
  const apiRoot = {
    orders: () => ({
      withId: () => ({
        get: () => ({ execute: async () => ({ body: order }) }),
        post,
      }),
    }),
  };
  const dabus = {
    findOrder: jest.fn(async () => undefined),
    createOrder: jest.fn(async () => undefined),
    updateOrder: jest.fn(async () => undefined),
  };
  const deps = { apiRoot, dabus, orderOrigin: 'commercetools' } as never;
  return { post: post as jest.Mock, dabus, deps };
}

const created = (order: Order) => ({ type: 'OrderCreated' as const, orderId: order.id, order });

describe('order sync', () => {
  it('creates the order in DaBus and records SYNCED', async () => {
    const order = makeOrder();
    const { dabus, deps, post } = setup(order);
    expect(await syncOrder(created(order), deps)).toBe('synced');
    expect(dabus.createOrder).toHaveBeenCalledTimes(1);
    const { actions } = post.mock.calls[0][0].body;
    expect(actions[0]).toMatchObject({ action: 'setCustomType', fields: { dabusSyncStatus: 'SYNCED' } });
  });

  it('skips DaBus-originated changes and clears the flag', async () => {
    const order = makeOrder({ lastUpdatedBy: 'dabus' });
    const { dabus, deps, post } = setup(order);
    expect(await syncOrder(created(order), deps)).toBe('skipped');
    expect(dabus.findOrder).not.toHaveBeenCalled();
    expect(post.mock.calls[0][0].body.actions).toEqual([
      { action: 'setCustomField', name: 'lastUpdatedBy', value: 'commercetools' },
    ]);
  });

  it('updates an existing order on OrderStateChanged', async () => {
    const order = makeOrder();
    const { dabus, deps } = setup(order);
    dabus.findOrder.mockResolvedValue({ orderNumber: 'order-1' } as never);
    await syncOrder({ type: 'OrderStateChanged', orderId: 'o1' }, deps);
    expect(dabus.updateOrder).toHaveBeenCalledTimes(1);
    expect(dabus.createOrder).not.toHaveBeenCalled();
  });

  it('marks unmappable orders FAILED without throwing', async () => {
    const order = { ...makeOrder(), orderNumber: undefined } as unknown as Order;
    const { deps, post } = setup(order);
    expect(await syncOrder(created(order), deps)).toBe('failed');
    expect(JSON.stringify(post.mock.calls[0][0])).toContain('FAILED');
  });

  it('rethrows retryable DaBus failures and records nothing', async () => {
    const order = makeOrder();
    const { dabus, deps, post } = setup(order);
    dabus.createOrder.mockRejectedValue(new DabusApiError('down', 503));
    await expect(syncOrder(created(order), deps)).rejects.toThrow('down');
    expect(post).not.toHaveBeenCalled();
  });

  it('parses only order messages', () => {
    expect(parseOrderMessage({ notificationType: 'ResourceCreated' })).toBeUndefined();
    expect(parseOrderMessage({ type: 'OrderStateChanged', resource: { id: 'o1' } })).toEqual({
      type: 'OrderStateChanged',
      orderId: 'o1',
      order: undefined,
    });
  });
});
