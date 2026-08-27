export interface Config {
  port: number;
  host: string;
  databasePath: string;
  piSessionStoragePath: string;
  piCodingAgentDir: string;
  logLevel: string;
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const host = readEnv('HOST', '127.0.0.1');
if (host !== '127.0.0.1') {
  throw new Error(
    `HOST must be 127.0.0.1 (loopback-only, FR-044); got "${host}". Network exposure is unsupported.`,
  );
}

export const config: Config = {
  port: Number(readEnv('PORT', '3000')),
  host,
  databasePath: readEnv('DATABASE_PATH', './data/document-review.sqlite'),
  piSessionStoragePath: readEnv('PI_SESSION_STORAGE_PATH', './data/pi-sessions'),
  piCodingAgentDir: readEnv('PI_CODING_AGENT_DIR', './data/pi-agent'),
  logLevel: readEnv('LOG_LEVEL', 'info'),
};
