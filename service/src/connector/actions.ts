import type { FieldDefinition } from '@commercetools/platform-sdk';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';

const CUSTOM_TYPE_KEY = 'dabus-order-sync-metadata';

const FIELD_DEFINITIONS: FieldDefinition[] = ['lastUpdatedBy', 'dabusSyncStatus'].map(
  (name) => ({
    name,
    label: { en: name === 'lastUpdatedBy' ? 'Last updated by' : 'Dabus sync status' },
    required: false,
    type: { name: 'String' },
    inputHint: 'SingleLine',
  })
);

/** Idempotent: creates the Order custom type or adds any missing fields. */
export async function ensureOrderSyncCustomType(
  apiRoot: ByProjectKeyRequestBuilder
): Promise<void> {
  const {
    body: { results },
  } = await apiRoot
    .types()
    .get({ queryArgs: { where: `key = "${CUSTOM_TYPE_KEY}"` } })
    .execute();

  if (results.length === 0) {
    await apiRoot
      .types()
      .post({
        body: {
          key: CUSTOM_TYPE_KEY,
          name: { en: 'Dabus order sync metadata' },
          resourceTypeIds: ['order'],
          fieldDefinitions: FIELD_DEFINITIONS,
        },
      })
      .execute();
    return;
  }

  const type = results[0];
  const present = new Set(type.fieldDefinitions.map((field) => field.name));
  const missing = FIELD_DEFINITIONS.filter((field) => !present.has(field.name));
  if (missing.length === 0) return;
  await apiRoot
    .types()
    .withKey({ key: CUSTOM_TYPE_KEY })
    .post({
      body: {
        version: type.version,
        actions: missing.map((fieldDefinition) => ({
          action: 'addFieldDefinition',
          fieldDefinition,
        })),
      },
    })
    .execute();
}
