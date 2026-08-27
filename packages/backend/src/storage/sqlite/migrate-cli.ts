import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../config.js';
import { SqliteStorageAdapter } from './index.js';

mkdirSync(dirname(config.databasePath), { recursive: true });
const adapter = new SqliteStorageAdapter(config.databasePath);
adapter.close();
console.log(`Migrated ${config.databasePath}`);
