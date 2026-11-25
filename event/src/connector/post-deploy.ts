import { createApiRoot } from '../client/create.client';
import { Config } from '../interfaces/config.interface';
import {
  createOrderSubscription,
  ensureOrderSyncCustomType,
} from './actions';
import { readConfiguration } from '../utils/config.utils';

async function postDeploy(config: Config): Promise<void> {
  const apiRoot = createApiRoot();
  await ensureOrderSyncCustomType(apiRoot);
  await createOrderSubscription(apiRoot, config);
}

async function run(): Promise<void> {
  try {
    const config = readConfiguration();
    await postDeploy(config);
  } catch (error) {
    const errorWithBody =
      typeof error === 'object' && error !== null && 'body' in error
        ? error
        : undefined;
    const details =
      errorWithBody?.body ||
      (error instanceof Error ? error.message : undefined) ||
      error;
    let serialized: string;
    if (typeof details === 'string') {
      serialized = details;
    } else {
      try {
        serialized = JSON.stringify(details, null, 2) ?? String(details);
      } catch {
        serialized = String(details);
      }
    }
    process.stderr.write(`Post-deploy failed: ${serialized}\n`);
    process.exitCode = 1;
  }
}

run();
