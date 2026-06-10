#!/usr/bin/env node
// PodNet one-command setup — provisions and deploys the whole app to Cloudflare.
//
//   npm run setup
//
// What it does (each step is idempotent — safe to re-run):
//   1. Installs npm dependencies.
//   2. Authenticates with Cloudflare (CLOUDFLARE_API_TOKEN if set, else `wrangler login`).
//   3. Creates the D1 database "podnet" and writes its id into wrangler.toml.
//   4. Applies schema.sql to the remote database.
//   5. Creates the Pages project "podnet".
//   6. Generates SESSION_SECRET and stores it as a Pages secret (only if not set).
//   7. Deploys the site (static public/ + functions/) and prints the live URL.
//
// NOTE on auth: Cloudflare's CLI does NOT take an email+password. Either:
//   • export CLOUDFLARE_API_TOKEN=...  (recommended; fully scriptable), or
//   • run interactively and let `wrangler login` open your browser.
// An API token needs these permissions (Account scope):
//   D1:Edit, Cloudflare Pages:Edit, Workers Scripts:Edit, Account Settings:Read.
// If you have more than one account, also set CLOUDFLARE_ACCOUNT_ID.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = 'podnet'
const WRANGLER_TOML = join(ROOT, 'wrangler.toml')

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
}
let step = 0
const heading = (m) => console.log(`\n${c.bold}${c.cyan}[${++step}] ${m}${c.reset}`)
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`)
const info = (m) => console.log(`${c.dim}${m}${c.reset}`)
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`)
const die = (m) => {
  console.error(`\n${c.red}✗ ${m}${c.reset}`)
  process.exit(1)
}

// Run a command. Returns {status, stdout, stderr}. Inherits stdio when interactive.
function run(cmd, args, { capture = false, input } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  })
  return res
}
const wrangler = (args, opts) => run('npx', ['--no-install', 'wrangler', ...args], opts)

// --- 1. dependencies ------------------------------------------------------
heading('Installing dependencies')
if (run('npm', ['install']).status !== 0) die('npm install failed')
ok('Dependencies installed')

// --- 2. authentication ----------------------------------------------------
heading('Checking Cloudflare authentication')
if (process.env.CLOUDFLARE_API_TOKEN) {
  info('Using CLOUDFLARE_API_TOKEN from the environment.')
} else {
  const who = wrangler(['whoami'], { capture: true })
  const authed = who.status === 0 && !/not authenticated/i.test(who.stdout + who.stderr)
  if (!authed) {
    warn('Not authenticated. Launching `wrangler login` (opens a browser)…')
    warn('Tip: for non-interactive setup, export CLOUDFLARE_API_TOKEN instead.')
    if (wrangler(['login']).status !== 0) die('wrangler login failed')
  }
}
ok('Authenticated with Cloudflare')

// --- 3. D1 database -------------------------------------------------------
heading(`Ensuring D1 database "${PROJECT}"`)
let databaseId = findExistingD1(PROJECT)
if (databaseId) {
  ok(`Found existing database (${databaseId})`)
} else {
  const created = wrangler(['d1', 'create', PROJECT], { capture: true })
  const out = `${created.stdout}\n${created.stderr}`
  databaseId = (out.match(/database_id\s*=\s*"([0-9a-f-]+)"/i) || [])[1]
  if (!databaseId) {
    // Maybe it already exists but the regex above missed it; re-list.
    databaseId = findExistingD1(PROJECT)
  }
  if (!databaseId) die(`Could not create or find the D1 database.\n${out}`)
  ok(`Created database (${databaseId})`)
}
writeDatabaseId(databaseId)
ok('wrangler.toml updated with the database id')

// --- 4. schema ------------------------------------------------------------
heading('Applying schema to the remote database')
if (wrangler(['d1', 'execute', PROJECT, '--remote', '--file', 'schema.sql', '-y']).status !== 0) {
  die('Failed to apply schema.sql')
}
ok('Schema applied')

// --- 4a. migrations (ALTERs for databases created by older versions) ------
heading('Applying migrations')
const migrationsDir = join(ROOT, 'migrations')
for (const file of readdirSync(migrationsDir).sort()) {
  if (!file.endsWith('.sql')) continue
  const res = wrangler(
    ['d1', 'execute', PROJECT, '--remote', '--file', `migrations/${file}`, '-y'],
    {
      capture: true,
    },
  )
  const out = `${res.stdout}\n${res.stderr}`
  if (res.status === 0) ok(`migration ${file} applied`)
  else if (/duplicate column name/i.test(out)) ok(`migration ${file} already applied`)
  else die(`Migration ${file} failed.\n${out}`)
}

// --- 4b. R2 bucket for photos --------------------------------------------
heading('Ensuring R2 bucket "podnet-photos"')
const mkBucket = wrangler(['r2', 'bucket', 'create', 'podnet-photos'], { capture: true })
const bucketOut = `${mkBucket.stdout}\n${mkBucket.stderr}`
if (mkBucket.status === 0) ok('R2 bucket created')
else if (/already (exists|owned)/i.test(bucketOut)) ok('R2 bucket already exists')
else die(`Could not create the R2 bucket.\n${bucketOut}`)

// --- 5. Pages project -----------------------------------------------------
heading(`Ensuring Pages project "${PROJECT}"`)
const createProj = wrangler(
  ['pages', 'project', 'create', PROJECT, '--production-branch', 'main'],
  { capture: true },
)
const projOut = `${createProj.stdout}\n${createProj.stderr}`
if (createProj.status === 0) ok('Pages project created')
else if (/already exists/i.test(projOut)) ok('Pages project already exists')
else die(`Could not create the Pages project.\n${projOut}`)

// --- 6. SESSION_SECRET ----------------------------------------------------
heading('Ensuring SESSION_SECRET')
const secretList = wrangler(['pages', 'secret', 'list', '--project-name', PROJECT], {
  capture: true,
})
if (/SESSION_SECRET/.test(secretList.stdout)) {
  ok('SESSION_SECRET already set (left unchanged)')
} else {
  const secret = randomBytes(48).toString('base64url')
  const put = wrangler(['pages', 'secret', 'put', 'SESSION_SECRET', '--project-name', PROJECT], {
    capture: true,
    input: `${secret}\n`,
  })
  if (put.status !== 0) die(`Failed to set SESSION_SECRET.\n${put.stdout}\n${put.stderr}`)
  ok('SESSION_SECRET generated and stored as a Pages secret')
}

// --- 6b. VAPID keys for web push -----------------------------------------
heading('Ensuring web-push (VAPID) keys')
if (/VAPID_PUBLIC_KEY/.test(secretList.stdout)) {
  ok('VAPID keys already set (left unchanged)')
} else {
  const { publicKey, privateJwk } = await generateVapidKeys()
  const set = (name, value) =>
    wrangler(['pages', 'secret', 'put', name, '--project-name', PROJECT], {
      capture: true,
      input: `${value}\n`,
    })
  if (set('VAPID_PUBLIC_KEY', publicKey).status !== 0) die('Failed to set VAPID_PUBLIC_KEY')
  if (set('VAPID_PRIVATE_KEY', JSON.stringify(privateJwk)).status !== 0)
    die('Failed to set VAPID_PRIVATE_KEY')
  set('VAPID_SUBJECT', 'mailto:podnet@example.com')
  ok('VAPID keypair generated and stored as Pages secrets')
}

// --- 7. deploy ------------------------------------------------------------
heading('Deploying to Cloudflare Pages')
const deploy = wrangler(
  ['pages', 'deploy', 'public', '--project-name', PROJECT, '--branch', 'main'],
  {
    capture: true,
  },
)
const deployOut = `${deploy.stdout}\n${deploy.stderr}`
process.stdout.write(deploy.stdout)
if (deploy.status !== 0) die(`Deploy failed.\n${deployOut}`)
const url = (deployOut.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/) || [])[0]

console.log(`\n${c.bold}${c.green}PodNet is live!${c.reset}`)
if (url) console.log(`${c.bold}${url}${c.reset}`)
else info('Deploy succeeded — see the URL in the output above.')
info('Re-run `npm run setup` anytime to redeploy; it will reuse the same DB and secret.')

// --- helpers --------------------------------------------------------------
function findExistingD1(name) {
  const list = wrangler(['d1', 'list', '--json'], { capture: true })
  if (list.status !== 0) return null
  try {
    const dbs = JSON.parse(list.stdout)
    const match = dbs.find((d) => d.name === name)
    return match ? match.uuid || match.database_id || null : null
  } catch {
    return null
  }
}

// Generate a P-256 VAPID keypair: public as base64url raw (65 bytes), private as JWK.
async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  const publicKey = Buffer.from(raw).toString('base64url')
  return { publicKey, privateJwk }
}

function writeDatabaseId(id) {
  const toml = readFileSync(WRANGLER_TOML, 'utf8')
  if (!/database_id\s*=/.test(toml)) die('wrangler.toml has no database_id line to update')
  const next = toml.replace(/database_id\s*=\s*".*"/, `database_id = "${id}"`)
  writeFileSync(WRANGLER_TOML, next)
}
