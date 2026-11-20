import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec: unknown = parse(
  readFileSync(resolve(root, '../dabus-connect/swagger.yml'), 'utf8'),
);
if (!isRecord(spec) || !Array.isArray(spec.servers) || !isRecord(spec.paths)) {
  throw new Error('Dabus OpenAPI specification has an invalid server or paths section');
}
const server = spec.servers[0];
if (!isRecord(server) || !isRecord(server.variables) || typeof server.url !== 'string') {
  throw new Error('Dabus OpenAPI specification has an invalid server');
}
const variables = server.variables;
const expandedUrl = server.url.replace(/\{([^}]+)\}/g, (_match, name: string) => {
  const variable = variables[name];
  if (!isRecord(variable) || typeof variable.default !== 'string' || !variable.default) {
    throw new Error(`Missing default for server variable ${name}`);
  }
  return variable.default;
});
const url = new URL(expandedUrl);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '4000' ||
    url.username || url.password || url.search || url.hash) {
  throw new Error('The mock server must use http://127.0.0.1:4000');
}
const prefix = url.pathname.replace(/\/$/, '');
const paths = Object.fromEntries(
  Object.entries(spec.paths).map(([path, operation]) => [`${prefix}${path}`, operation])
);
paths['/'] = {
  get: {
    operationId: 'mockHealth',
    security: [],
    responses: {
      '200': {
        description: 'Local Dabus mock is running',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { status: { type: 'string' } } },
            example: { status: 'mock' },
          },
        },
      },
    },
  },
};

const tempDir = mkdtempSync(join(tmpdir(), 'dabus-mock-'));
const tempSpec = join(tempDir, 'swagger.yml');
writeFileSync(tempSpec, stringify({ ...spec, servers: [{ url: url.origin }], paths }));
const prism = spawn(join(root, 'node_modules/.bin/prism'), [
  'mock', tempSpec, '--host', '127.0.0.1', '--port', '4000',
], { stdio: 'inherit' });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  unlinkSync(tempSpec);
  rmdirSync(tempDir);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => prism.kill(signal));
}
prism.on('error', (error) => {
  cleanup();
  console.error('Unable to start the Dabus mock:', error.message);
  process.exitCode = 1;
});
prism.on('exit', (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal ? 1 : 0);
});
