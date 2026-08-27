// A fresh directory per test-runner process avoids racing a leftover DB file from a previous
// run against this run's webServer, which starts concurrently with globalSetup (not after it).
const RUN_DIR = `/tmp/rapid-ai-doc-review-e2e-${process.pid}`;

export const E2E_BACKEND_PORT = 3999;
export const E2E_DATABASE_PATH = `${RUN_DIR}/db.sqlite`;
export const E2E_PI_SESSION_PATH = `${RUN_DIR}/pi-sessions`;
export const E2E_PI_AGENT_DIR = `${RUN_DIR}/pi-agent`;
