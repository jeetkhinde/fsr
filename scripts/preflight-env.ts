#!/usr/bin/env bun
/**
 * Preflight for the integration suites.
 *
 * `bun --env-file=<path>` silently ignores a missing file, so a fresh clone or
 * a new git worktree — where the gitignored `test-app/.env` does not exist —
 * runs the whole integration run with no DATABASE_URL and fails deep inside a
 * suite with `database "<unix-user>" does not exist`. Check up front instead
 * and say exactly what to do.
 *
 * Exit codes:
 *   0 — env file present with every required key set (services may still be down)
 *   1 — env file missing, or a required key missing/empty
 *
 * Unreachable Postgres/Redis is reported as a warning, not a failure: the
 * suites already probe and skip themselves, and requiring live services to run
 * `bun run test` would be a regression for anyone working on unit tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE = 'test-app/.env';
const EXAMPLE_FILE = 'test-app/.env.example';
const REQUIRED = ['DATABASE_URL', 'REDIS_URL'] as const;

/** Minimal dotenv reader — only what the check needs: KEY=value, `#` comments. */
function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/** Never print a password to the terminal, even the developer's own. */
function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1:****@');
}

function fail(message: string): never {
  console.error(`\n✖ preflight: ${message}\n`);
  process.exit(1);
}

const root = process.cwd();
const envPath = resolve(root, ENV_FILE);

if (!existsSync(envPath)) {
  fail(
    `${ENV_FILE} is missing — the integration suites need it.\n\n` +
      `  cp ${EXAMPLE_FILE} ${ENV_FILE}\n\n` +
      `  Then edit ${ENV_FILE} so DATABASE_URL and REDIS_URL point at your local\n` +
      `  Postgres and Redis. ${ENV_FILE} is gitignored, so every fresh clone and\n` +
      `  every new git worktree needs this once.`,
  );
}

const env = parseEnv(readFileSync(envPath, 'utf8'));
const missing = REQUIRED.filter((key) => !env.get(key));

if (missing.length > 0) {
  fail(
    `${ENV_FILE} is missing ${missing.length === 1 ? 'a required key' : 'required keys'}: ` +
      `${missing.join(', ')}.\n\n  See ${EXAMPLE_FILE} for what each one is for.`,
  );
}

// Reachability is advisory only — warn and let the suites make their own call.
const warnings: string[] = [];

const databaseUrl = env.get('DATABASE_URL')!;
try {
  const { SQL } = await import('bun');
  const probe = new SQL(databaseUrl);
  try {
    await probe`SELECT 1`;
  } finally {
    probe.close();
  }
} catch (err: any) {
  warnings.push(
    `Postgres at ${maskUrl(databaseUrl)} is not reachable (${err?.message ?? err}). ` +
      `Suites that need it will skip.`,
  );
}

const redisUrl = env.get('REDIS_URL')!;
try {
  const { RedisClient } = await import('bun');
  const probe = new RedisClient(redisUrl);
  try {
    await probe.connect();
    await probe.send('PING', []);
  } finally {
    probe.close();
  }
} catch (err: any) {
  warnings.push(
    `Redis at ${maskUrl(redisUrl)} is not reachable (${err?.message ?? err}). ` +
      `Suites that need it will skip.`,
  );
}

for (const warning of warnings) console.warn(`⚠ preflight: ${warning}`);
if (warnings.length === 0) console.log('✔ preflight: test-app/.env present, Postgres and Redis reachable.');
