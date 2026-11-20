import type { Address, CentPrecisionMoney, Customer, LineItem, Order, TaxedItemPrice } from '@commercetools/platform-sdk';
import { alpha2ToAlpha3 } from 'i18n-iso-countries';
import {
  Order as DabusOrder,
  CustomerAddress as DabusAddress,
} from '../generated/dabus-client';

const STATUS_BY_ORDER_STATE: Record<string, DabusOrder.StatusEnum> = {
  Open: DabusOrder.StatusEnum.Pending,
  Confirmed: DabusOrder.StatusEnum.Processing,
  Complete: DabusOrder.StatusEnum.Complete,
  Cancelled: DabusOrder.StatusEnum.Canceled,
};

export type OrderForExport = Pick<Order,
  'orderNumber' | 'orderState' | 'createdAt' | 'customerEmail' | 'customerId' | 'locale' |
  'billingAddress' | 'shippingAddress' | 'customLineItems'
> & {
  taxedPrice?: { totalGross: CentPrecisionMoney };
  lineItems: Array<Pick<LineItem, 'name' | 'quantity'> & {
    variant: { sku?: string };
    taxedPrice?: Pick<TaxedItemPrice, 'totalNet' | 'totalGross'>;
  }>;
};

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`Missing required order field: ${field}`);
  return value;
}

function amount(money: CentPrecisionMoney): number {
  if (!Number.isSafeInteger(money.centAmount) || !Number.isInteger(money.fractionDigits) ||
      money.fractionDigits < 0 || money.fractionDigits > 20) {
    throw new Error('Invalid monetary amount');
  }
  return money.centAmount / 10 ** money.fractionDigits;
}

function mapAddress(address: Address, type: DabusAddress['addressType']): DabusAddress {
  const street = [address.streetName, address.streetNumber].filter(Boolean).join(' ');
  const country = alpha2ToAlpha3(address.country);
  if (!country) throw new Error('Unsupported address country');
  return {
    street1: required(street, `${String(type)} street`),
    country,
    addressType: type,
    ...(address.additionalStreetInfo && { street2: address.additionalStreetInfo }),
    ...(address.city && { city: address.city }),
    ...(address.state && { state: address.state }),
    ...(address.postalCode && { postcode: address.postalCode }),
    ...(address.phone && { telephone: address.phone }),
    ...(address.company && { company: address.company }),
    ...(address.firstName && { contactName: address.firstName }),
    ...(address.lastName && { lastName: address.lastName }),
  };
}

export function mapOrder(order: OrderForExport, customer: Customer | undefined, origin: string): DabusOrder {
  if (order.customLineItems.length) throw new Error('Custom line items cannot be mapped to DaBus');
  if (!order.taxedPrice) throw new Error('Order has no calculated tax totals');
  const address = order.billingAddress ?? order.shippingAddress;
  const email = required(order.customerEmail ?? customer?.email, 'customer email');
  const firstName = required(customer?.firstName ?? address?.firstName, 'customer first name');
  const lastName = required(customer?.lastName ?? address?.lastName, 'customer last name');
  const addresses: DabusAddress[] = [];
  if (order.billingAddress) addresses.push(mapAddress(order.billingAddress, DabusAddress.AddressTypeEnum.Billing));
  if (order.shippingAddress) addresses.push(mapAddress(order.shippingAddress, DabusAddress.AddressTypeEnum.Shipping));

  return {
    orderNumber: required(order.orderNumber, 'order number'),
    orderOrigin: required(origin, 'order origin'),
    customer: {
      email,
      firstName: firstName,
      lastName: lastName,
      ...(order.customerId && { identifier: order.customerId }),
    },
    isGuest: !order.customerId,
    currency: order.taxedPrice.totalGross.currencyCode,
    total: amount(order.taxedPrice.totalGross),
    contactEmail: email,
    orderItems: order.lineItems.map((item) => {
      if (!item.taxedPrice || item.quantity <= 0) {
        throw new Error('Order line has no calculated tax totals or quantity');
      }
      if (item.taxedPrice.totalNet.currencyCode !== order.taxedPrice?.totalGross.currencyCode ||
          item.taxedPrice.totalGross.currencyCode !== order.taxedPrice?.totalGross.currencyCode ||
          item.taxedPrice.totalNet.fractionDigits !== item.taxedPrice.totalGross.fractionDigits) {
        throw new Error('Order line monetary values do not match');
      }
      const net = amount(item.taxedPrice.totalNet);
      const gross = amount(item.taxedPrice.totalGross);
      const name = order.locale ? item.name[order.locale] : undefined;
      return {
        sku: required(item.variant.sku, 'line item SKU'),
        qty: item.quantity,
        price: net / item.quantity,
        priceInclTax: gross / item.quantity,
        rowTotal: net,
        rowTotalInclTax: gross,
        taxAmount: (item.taxedPrice.totalGross.centAmount - item.taxedPrice.totalNet.centAmount) /
          10 ** item.taxedPrice.totalGross.fractionDigits,
        ...(name && { name }),
      };
    }),
    addresses,
    status: STATUS_BY_ORDER_STATE[order.orderState],
    createdAt: new Date(order.createdAt),
  };
}
