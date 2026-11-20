import { mapOrder, type OrderForExport } from '../../src/mappers/orderMapper';

const money = (centAmount: number) => ({
  type: 'centPrecision' as const,
  currencyCode: 'AUD',
  centAmount,
  fractionDigits: 2,
});

const order = {
  orderNumber: 'order-1',
  orderState: 'Confirmed' as const,
  createdAt: '2026-11-16T00:00:00.000Z',
  customerEmail: 'shopper@example.com',
  locale: 'en-AU',
  billingAddress: {
    firstName: 'Ada',
    lastName: 'Test',
    streetName: 'Main Street',
    streetNumber: '2',
    country: 'AU',
  },
  customLineItems: [],
  taxedPrice: { totalGross: money(1100) },
  lineItems: [{
    variant: { sku: 'sku-1' },
    name: { 'en-AU': 'Example' },
    quantity: 2,
    taxedPrice: { totalNet: money(1000), totalGross: money(1100) },
  }],
} satisfies OrderForExport;

describe('Dabus order mapping', () => {
  it('maps totals, tax, customer, and ISO alpha-3 addresses', () => {
    const mapped = mapOrder(order, undefined, 'commercetools');
    expect(mapped.total).toBe(11);
    expect(mapped.status).toBe('processing');
    expect(mapped.addresses?.[0].country).toBe('AUS');
    expect(mapped.orderItems?.[0]).toMatchObject({
      sku: 'sku-1', qty: 2, price: 5, priceInclTax: 5.5, taxAmount: 1,
    });
    expect(mapped.customer).toEqual({
      email: 'shopper@example.com', firstName: 'Ada', lastName: 'Test',
    });
  });

  it('rejects orders without a stable order number or tax totals', () => {
    expect(() => mapOrder({ ...order, orderNumber: undefined }, undefined, 'ct'))
      .toThrow('order number');
    expect(() => mapOrder({ ...order, taxedPrice: undefined }, undefined, 'ct'))
      .toThrow('tax totals');
  });
});
