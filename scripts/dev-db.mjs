// Starts a real PostgreSQL server for local development without Docker.
// Data lives in ./.pgdata and survives restarts. Stop with Ctrl+C.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databaseDir = path.join(root, '.pgdata');
const port = Number(process.env.PGPORT ?? 5434);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'convo',
  password: 'convo',
  port,
  persistent: true,
  // Without these, Windows creates a WIN1252 cluster that cannot store characters like "ş".
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
});

if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) {
  console.log('Initialising a new database cluster in .pgdata ...');
  await pg.initialise();
}

try {
  await pg.start();
} catch (err) {
  console.error(`Could not start PostgreSQL on port ${port}.`);
  console.error('Is another server already using it? Pick another port with PGPORT=5434 npm run db:start');
  console.error('(then update DATABASE_URL in apps/api/.env to match).');
  if (err) console.error(err);
  process.exit(1);
}

for (const name of ['convo', 'convo_test']) {
  try {
    await pg.createDatabase(name);
    console.log(`Created database "${name}"`);
  } catch {
    // Already exists.
  }
}

console.log(`PostgreSQL is running on postgresql://convo:convo@localhost:${port}/convo`);
console.log('Press Ctrl+C to stop.');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping PostgreSQL ...');
  await pg.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the process alive.
setInterval(() => {}, 1 << 30);
