import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../config.ts';
import { SqliteStorageAdapter } from './index.ts';

mkdirSync(dirname(config.databasePath), { recursive: true });
const adapter = new SqliteStorageAdapter(config.databasePath);
adapter.close();
console.log(`Migrated ${config.databasePath}`);
