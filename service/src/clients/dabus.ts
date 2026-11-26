import {
  Configuration,
  InventorySourceItem,
  InventorySourceItemRepositoryV1Api,
  Order,
  OrderRepositoryV1Api,
  Product,
  ProductRepositoryV1Api,
  Shipment,
  ShipmentRepositoryV1Api,
} from '../generated/dabus-client';
import { logger } from '../utils/logger.utils';

interface DabusSettings {
  baseUrl: string;
  authUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

interface DabusTokenResponse {
  access_token: string;
  expires_in?: number;
}

const REQUEST_TIMEOUT_MS = 8000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', 'host.docker.internal'].includes(
    url.hostname
  );
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an HTTPS URL without credentials, query, or fragment`
    );
  }
  return url.toString().replace(/\/$/, '');
}

function readDabusSettings(
  env: Record<string, string | undefined> = process.env
): DabusSettings {
  const clientId = env.DABUS_CLIENT_ID;
  const clientSecret = env.DABUS_CLIENT_SECRET;
  const authUrl = env.DABUS_AUTH_URL;
  if (!clientId || !clientSecret || !authUrl) {
    throw new Error(
      'Missing Dabus client configuration: DABUS_CLIENT_ID, DABUS_CLIENT_SECRET and DABUS_AUTH_URL are required'
    );
  }
  return {
    baseUrl: validateUrl(env.DABUS_BASE_URL, 'DABUS_BASE_URL'),
    authUrl:
      authUrl === 'local-bypass' ? authUrl : validateUrl(authUrl, 'DABUS_AUTH_URL'),
    clientId,
    clientSecret,
    scope: env.DABUS_SCOPE?.trim() || undefined,
  };
}

function isTokenResponse(value: unknown): value is DabusTokenResponse {
  return (
    isRecord(value) &&
    typeof value.access_token === 'string' &&
    value.access_token.length > 0 &&
    (value.expires_in === undefined || typeof value.expires_in === 'number')
  );
}

const toSnakeCase = (key: string) =>
  key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
const toCamelCase = (key: string) =>
  key.replace(/_([a-z0-9])/g, (_match, character: string) =>
    character.toUpperCase()
  );

function convertKeys(
  value: unknown,
  convert: (key: string) => string
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertKeys(item, convert));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        convert(key),
        convertKeys(item, convert),
      ])
    );
  }
  return value;
}

class DabusApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'DabusApiError';
  }
}

export class DabusJobsClient {
  private token?: { value: string; expiresAt: number };
  private readonly productsApi: ProductRepositoryV1Api;
  private readonly inventoryApi: InventorySourceItemRepositoryV1Api;
  private readonly ordersApi: OrderRepositoryV1Api;
  private readonly shipmentsApi: ShipmentRepositoryV1Api;

  constructor(
    private readonly settings: DabusSettings,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const fetcher = this.createFetch();
    const configuration = new Configuration({ basePath: settings.baseUrl });
    this.productsApi = new ProductRepositoryV1Api(
      configuration,
      settings.baseUrl,
      fetcher as never
    );
    this.inventoryApi = new InventorySourceItemRepositoryV1Api(
      configuration,
      settings.baseUrl,
      fetcher as never
    );
    this.ordersApi = new OrderRepositoryV1Api(
      configuration,
      settings.baseUrl,
      fetcher as never
    );
    this.shipmentsApi = new ShipmentRepositoryV1Api(
      configuration,
      settings.baseUrl,
      fetcher as never
    );
  }

  private createFetch(): typeof fetch {
    return async (input, init) => {
      const token = await this.accessToken();
      const body =
        typeof init?.body === 'string'
          ? JSON.stringify(convertKeys(JSON.parse(init.body), toSnakeCase))
          : init?.body;
      let response: Response;
      try {
        response = await this.fetchImpl(input, {
          ...init,
          body,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...(token && { authorization: `Bearer ${token}` }),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: 'error',
        });
      } catch (error) {
        throw new DabusApiError(`Dabus request failed: ${String(error)}`);
      }
      if (!response.ok) return response;
      const text = await response.text();
      const converted = text
        ? JSON.stringify(convertKeys(JSON.parse(text), toCamelCase))
        : '{}';
      return new Response(converted, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  private async accessToken(): Promise<string> {
    if (this.settings.authUrl === 'local-bypass') {
      logger.warn('DABUS_AUTH_URL is local-bypass; skipping Dabus OAuth2');
      return '';
    }
    if (this.token && this.token.expiresAt > Date.now()) {
      return this.token.value;
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.settings.scope) body.set('scope', this.settings.scope);
    let response: Response;
    try {
      response = await this.fetchImpl(this.settings.authUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(
            `${this.settings.clientId}:${this.settings.clientSecret}`
          ).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      throw new DabusApiError(`Dabus token request failed: ${String(error)}`);
    }
    if (!response.ok) {
      throw new DabusApiError(
        `Dabus token request failed: ${response.status}`,
        response.status
      );
    }
    const token: unknown = await response.json();
    if (!isTokenResponse(token)) {
      throw new DabusApiError('Dabus token response is invalid', 502);
    }
    const lifetimeMs = (token.expires_in ?? 300) * 1000;
    this.token = {
      value: token.access_token,
      expiresAt: Date.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS),
    };
    return token.access_token;
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DabusApiError) throw error;
      if (error instanceof Response) {
        throw new DabusApiError(
          `Dabus request failed: ${error.status}`,
          error.status
        );
      }
      throw error;
    }
  }

  async searchProducts(): Promise<Product[]> {
    return this.call(async () =>
      (await this.productsApi.productRepositoryV1Search(
        undefined,
        undefined,
        1,
        10
      )).products
    );
  }

  async searchInventoryItems(): Promise<InventorySourceItem[]> {
    return this.call(async () =>
      (
        await this.inventoryApi.inventorySourceItemRepositoryV1Search(
          undefined,
          undefined,
          1,
          10
        )
      ).inventorySourceItems
    );
  }

  async searchOrders(): Promise<Order[]> {
    return this.call(async () =>
      (
        await this.ordersApi.orderRepositoryV1Search(
          undefined,
          undefined,
          1,
          10
        )
      ).orders
    );
  }

  async searchShipments(): Promise<Shipment[]> {
    return this.call(async () =>
      (
        await this.shipmentsApi.shipmentRepositoryV1Search(
          undefined,
          undefined,
          1,
          10
        )
      ).shipments
    );
  }
}

let client: DabusJobsClient | undefined;

export function getDabusClient(): DabusJobsClient {
  client ??= new DabusJobsClient(readDabusSettings());
  return client;
}
