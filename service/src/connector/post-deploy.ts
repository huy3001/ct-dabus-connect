import dotenv from 'dotenv';
dotenv.config();

import { createApiRoot } from '../client/create.client';
import { assertError } from '../utils/assert.utils';
import { ensureOrderSyncCustomType } from './actions';

async function run(): Promise<void> {
  try {
    await ensureOrderSyncCustomType(createApiRoot());
  } catch (error) {
    assertError(error);
    process.stderr.write(`Post-deploy failed: ${error.message}`);
    process.exitCode = 1;
  }
}

run();
