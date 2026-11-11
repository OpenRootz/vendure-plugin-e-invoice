import { ConfigService, EntityIdStrategy, ID } from '@vendure/core';

import { LayoutSettings } from '../entities';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function strategy(config: ConfigService): EntityIdStrategy<'increment' | 'uuid'> | undefined {
  return config.entityOptions.entityIdStrategy ?? config.entityIdStrategy;
}

/** An entity ID as the API exposes it (encoded by the configured `EntityIdStrategy`). */
export function encodeEntityId(config: ConfigService, id: ID): ID {
  const s = strategy(config);
  return s ? s.encodeId(id as never) : id;
}

/** An API ID as it is stored in the database (decoded by the configured `EntityIdStrategy`). */
export function decodeEntityId(config: ConfigService, id: ID): ID {
  const s = strategy(config);
  return s ? s.decodeId(String(id)) : id;
}

/** Upper bound of the `integer` primary key columns of the increment strategy (Postgres `int4`). */
const MAX_INT_ID = 2 ** 31 - 1;

/** Whether a decoded ID fits the primary key column; anything else would make the database query fail. */
export function isStorableId(config: ConfigService, id: ID): boolean {
  if (strategy(config)?.primaryKeyType === 'uuid') return UUID.test(String(id));
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_INT_ID && String(n) === String(id);
}

/**
 * The asset IDs of image blocks live inside the JSON layout document, so Vendure's ID codec does not touch them
 * (unlike `logoAssetId`, a GraphQL `ID`). The API side holds encoded IDs, the database decoded ones.
 */
export function mapImageAssetIds(layout: LayoutSettings, map: (id: ID) => ID): LayoutSettings {
  if (!layout.blocks.some((b) => b.type === 'image' && b.props?.assetId !== undefined)) return layout;
  return {
    ...layout,
    blocks: layout.blocks.map((b) =>
      b.type === 'image' && b.props?.assetId !== undefined ? { ...b, props: { ...b.props, assetId: map(b.props.assetId as ID) } } : b,
    ),
  } as LayoutSettings;
}
