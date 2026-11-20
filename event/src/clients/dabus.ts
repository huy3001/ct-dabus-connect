import {
  Configuration,
  Order,
  OrderRepositoryV1Api,
} from '../generated/dabus-client';
import { logger } from '../utils/logger.utils';

export class DabusApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'DabusApiError';
  }

  /** Network failures, 408, 429 and 5xx can succeed on a later attempt. */
  get retryable(): boolean {
    return (
      this.status === undefined ||
      this.status === 408 ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

interface DabusSettings {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

const REQUEST_TIMEOUT_MS = 8000;
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

// Plain HTTP is accepted only for loopback hosts, e.g. a local Dabus mock.
function validatedUrl(value: string | undefined, name: string): string {
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

export function readDabusSettings(
  env: Record<string, string | undefined> = process.env
): DabusSettings {
  const { DABUS_CLIENT_ID: clientId, DABUS_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) {
    throw new Error('Missing Dabus client credentials');
  }
  return {
    baseUrl: validatedUrl(env.DABUS_BASE_URL, 'DABUS_BASE_URL'),
    tokenUrl: validatedUrl(env.DABUS_TOKEN_URL, 'DABUS_TOKEN_URL'),
    clientId,
    clientSecret,
  };
}

const snake = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const camel = (key: string) =>
  key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

export function convertKeys(
  value: unknown,
  convert: (key: string) => string
): unknown {
  if (Array.isArray(value)) return value.map((v) => convertKeys(v, convert));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        convert(k),
        convertKeys(v, convert),
      ])
    );
  }
  return value;
}

/**
 * The generated client does not apply the OAuth scheme, so the bearer token
 * is added here. It also names model properties in camelCase while the DaBus
 * wire format is snake_case, so keys are converted at the fetch boundary.
 */
export function createDabusFetch(
  fetchImpl: typeof fetch = fetch,
  getToken: () => Promise<string> = async () => ''
): typeof fetch {
  return async (input, init) => {
    const token = await getToken();
    const body =
      typeof init?.body === 'string'
        ? JSON.stringify(convertKeys(JSON.parse(init.body), snake))
        : init?.body;
    let response: Response;
    try {
      response = await fetchImpl(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      throw new DabusApiError(`Dabus request failed: ${String(error)}`);
    }
    if (response.status < 200 || response.status >= 300) return response;
    const text = await response.text();
    const converted = text ? convertKeys(JSON.parse(text), camel) : {};
    return new Response(JSON.stringify(converted), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function isTokenResponse(
  value: unknown
): value is { access_token: string; expires_in?: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'access_token' in value &&
    typeof value.access_token === 'string' &&
    value.access_token.length > 0
  );
}

export class DabusClient {
  private token?: { value: string; expiresAt: number };
  private readonly api: OrderRepositoryV1Api;

  constructor(
    private readonly settings: DabusSettings,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.api = new OrderRepositoryV1Api(
      new Configuration({ basePath: settings.baseUrl }),
      settings.baseUrl,
      createDabusFetch(fetchImpl, () => this.accessToken()) as never
    );
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const { clientId, clientSecret, tokenUrl } = this.settings;
    let response: Response;
    // Skip token request in local development mode
    if (tokenUrl === 'http://127.0.0.1:4000/oauth2/token') {
      logger.warn(
        'Dabus token URL is set to "http://127.0.0.1:4000/oauth2/token". Skipping token request for local development.'
      );
      return '';
    }
    try {
      response = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
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

  /** Returns undefined when Dabus has no order with this number. */
  async findOrder(orderNumber: string): Promise<Order | undefined> {
    try {
      return await this.call(() => this.api.orderRepositoryV1Get(orderNumber));
    } catch (error) {
      if (error instanceof DabusApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async createOrder(order: Order): Promise<void> {
    try {
      await this.call(() => this.api.orderRepositoryV1Create(order));
    } catch (error) {
      // Dabus rejects duplicate order numbers; a concurrent create is a success.
      if (
        error instanceof DabusApiError &&
        (error.status === 400 || error.status === 409) &&
        (await this.findOrder(order.orderNumber))
      ) {
        return;
      }
      throw error;
    }
  }

  async updateOrder(order: Order): Promise<void> {
    await this.call(() =>
      this.api.orderRepositoryV1Update(order, order.orderNumber)
    );
  }
}

let client: DabusClient | undefined;

export function getDabusClient(): DabusClient {
  client ??= new DabusClient(readDabusSettings());
  return client;
}
