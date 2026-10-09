import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { verifyJournalSchema } from '../src/db/journal-schema-audit.js';

import { journalCatalog } from './journal-catalog-fixture.js';

describe('journal catalog contract', () => {
  it('accepts Migration 008 with preserved canonical witness FK', async () => {
    const pool = { query: async (sql: string) => ({ rows: journalCatalog(sql) }) };
    await expect(verifyJournalSchema(pool as unknown as pg.Pool)).resolves.toBeUndefined();
  });
  for (const catalog of ['pg_constraint', 'pg_trigger', 'pg_attribute']) {
    it(`rejects missing ${catalog} evidence`, async () => {
      const pool = { query: async (sql: string) => ({ rows: sql.includes(catalog) ? [] : journalCatalog(sql) }) };
      await expect(verifyJournalSchema(pool as unknown as pg.Pool)).rejects.toThrow('Journal');
    });
  }
});
