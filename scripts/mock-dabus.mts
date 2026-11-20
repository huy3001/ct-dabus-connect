import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

type OpenApiObject = Record<string, unknown>;

function isRecord(value: unknown): value is OpenApiObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec: unknown = parse(
  readFileSync(resolve(root, 'swagger.yml'), 'utf8'),
);
if (!isRecord(spec) || !isRecord(spec.paths) || !isRecord(spec.components)) {
  throw new Error('DaBus OpenAPI specification has invalid paths or components');
}

const server = Array.isArray(spec.servers) ? spec.servers[0] : undefined;
if (!isRecord(server) || typeof server.url !== 'string' ||
    !isRecord(server.variables)) {
  throw new Error('DaBus OpenAPI specification has an invalid server');
}

const expandedBaseUrl = server.url.replace(
  /\{([^}]+)\}/g,
  (_match, name: string) => {
    const variable = server.variables?.[name];
    if (!isRecord(variable) || typeof variable.default !== 'string') {
      throw new Error(`Missing default for server variable ${name}`);
    }
    return variable.default;
  },
);
const baseUrl = new URL(expandedBaseUrl);
if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1' ||
    baseUrl.port !== '4000') {
  throw new Error('The local mock base URL must be http://127.0.0.1:4000');
}

function resolveSchema(schema: unknown, seen = new Set<string>()): OpenApiObject {
  if (!isRecord(schema)) return {};
  const ref = schema.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (seen.has(ref)) return {};
    seen.add(ref);
    return resolveSchema(
      ref.split('/').slice(1).reduce<unknown>((value, key) => {
        return isRecord(value) ? value[key] : undefined;
      }, spec),
      seen,
    );
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign(
      {},
      ...schema.allOf.map((item) => resolveSchema(item, new Set(seen))),
    );
  }
  return schema;
}

function exampleFor(schemaValue: unknown, seen = new Set<string>()): unknown {
  if (!isRecord(schemaValue)) return null;
  if (Object.hasOwn(schemaValue, 'example')) return schemaValue.example;
  if (Array.isArray(schemaValue.enum) && schemaValue.enum.length > 0) {
    return schemaValue.enum[0];
  }
  const schema = resolveSchema(schemaValue, seen);
  if (schema.type === 'array') {
    return Array.isArray(schema.example)
      ? schema.example
      : [exampleFor(schema.items, seen)];
  }
  if (schema.type === 'object' || isRecord(schema.properties)) {
    return Object.fromEntries(
      Object.entries(isRecord(schema.properties) ? schema.properties : {})
        .map(([name, property]) => [name, exampleFor(property, seen)]),
    );
  }
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
  return schema.format === 'email' ? 'mock@example.com' : 'mock';
}

function routeMatches(template: string, pathname: string): boolean {
  const expression = template.replace(/\{[^}]+\}/g, '[^/]+');
  return new RegExp(`^${expression}$`).test(pathname);
}

function responseFor(operation: OpenApiObject, method: string): {
  status: number;
  body: unknown;
} {
  const responses = isRecord(operation.responses) ? operation.responses : {};
  const statusKey =
    Object.keys(responses).find((status) => status.startsWith('2')) ?? '200';
  const response = responses[statusKey];
  const content =
    isRecord(response) && isRecord(response.content)
      ? response.content['application/json']
      : undefined;
  const body =
    isRecord(content) && Object.hasOwn(content, 'example')
      ? content.example
      : exampleFor(isRecord(content) ? content.schema : undefined);
  const empty = ['DELETE', 'HEAD'].includes(method.toUpperCase());
  return { status: Number(statusKey) || 200, body: empty ? undefined : body };
}

const prefix = baseUrl.pathname.replace(/\/$/, '');
const localServer = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', baseUrl).pathname;
  if (pathname === '/') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'mock' }));
    return;
  }
  const route = Object.entries(spec.paths).find(([path]) =>
    routeMatches(`${prefix}${path}`, pathname),
  );
  const operation =
    route && isRecord(route[1])
      ? route[1][(request.method ?? 'GET').toLowerCase()]
      : undefined;
  if (!isRecord(operation)) {
    response
      .writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ message: 'No documented DaBus operation' }));
    return;
  }
  const result = responseFor(operation, request.method ?? 'GET');
  response
    .writeHead(result.status, { 'content-type': 'application/json' })
    .end(
      result.body === undefined ? undefined : JSON.stringify(result.body),
    );
});

localServer.listen(4000, '127.0.0.1', () => {
  process.stdout.write(`DaBus mock listening at ${baseUrl.origin}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => localServer.close());
}
