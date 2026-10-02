// Creates disposable Admin / Staff / Member accounts on a LOCAL Supabase stack only.
// Refuses to run against any remote host, so it can never touch the hosted project.
// Addresses use the reserved .invalid TLD and are undeliverable; no mail is ever sent.
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {createClient} from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || '';
const host = url ? new URL(url).hostname : '';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw Error(`Refusing to seed: SUPABASE_URL must point at a local stack, got "${host || '(unset)'}".`);
}
if (!process.env.SUPABASE_SECRET_KEY) throw Error('SUPABASE_SECRET_KEY is required (use the local stack key).');

const db = createClient(url, process.env.SUPABASE_SECRET_KEY, {auth: {persistSession: false, autoRefreshToken: false}});
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const newPassword = () => 'Local9!' + randomBytes(18).toString('base64url');

const wanted = [
  {key: 'admin',  email: 'repready-local-admin@example.invalid',  role: 'admin',  name: 'LOCAL TEST Admin',  phone: '09170000101'},
  {key: 'staff',  email: 'repready-local-staff@example.invalid',  role: 'staff',  name: 'LOCAL TEST Staff',  phone: '09170000102'},
  {key: 'member', email: 'repready-local-member@example.invalid', role: 'member', name: 'LOCAL TEST Member', phone: '09170000103'}
];

const existing = [];
for (let page = 1; ; page++) {
  const {data, error} = await db.auth.admin.listUsers({page, perPage: 1000});
  if (error) throw Error('Unable to list local Auth users: ' + error.message);
  existing.push(...data.users);
  if (data.users.length < 1000) break;
}

const accounts = [];
for (const spec of wanted) {
  const previous = existing.find(u => u.email?.toLowerCase() === spec.email);
  if (previous) {
    // Disposable fixtures: remove and recreate so every run starts from a known state.
    for (const table of ['ff_notifications', 'ff_invoices', 'ff_memberships']) await db.from(table).delete().eq('member_id', previous.id);
    await db.from('ff_profiles').delete().eq('id', previous.id);
    const {error} = await db.auth.admin.deleteUser(previous.id);
    if (error) throw Error(`Could not remove the previous ${spec.key} fixture: ${error.message}`);
  }
  const password = newPassword();
  const user_metadata = {form_fitness: true, name: spec.name, phone: spec.phone};
  if (spec.role === 'member') Object.assign(user_metadata, {plan: 'basic', start: today, goal: 'Improve fitness'});
  const app_metadata = {ff_workspace: 'production'};
  if (spec.role !== 'member') app_metadata.ff_role = spec.role;

  const {data, error} = await db.auth.admin.createUser({email: spec.email, password, email_confirm: true, app_metadata, user_metadata});
  if (error) throw Error(`Could not create the ${spec.key} fixture: ${error.message}`);
  accounts.push({...spec, id: data.user.id, password});
}

// Verify the trigger provisioned each role correctly and that staff carry no financial records.
const checks = {};
for (const account of accounts) {
  const {data: profile, error} = await db.from('ff_profiles').select('*').eq('id', account.id).single();
  if (error) throw Error(`No profile for ${account.key}: ${error.message}`);
  const {data: cycles} = await db.from('ff_memberships').select('id').eq('member_id', account.id);
  const {data: invoices} = await db.from('ff_invoices').select('id').eq('member_id', account.id);
  checks[`${account.key}: role is ${account.role}`] = profile.role === account.role;
  checks[`${account.key}: workspace is production`] = profile.workspace === 'production';
  checks[`${account.key}: enabled`] = profile.enabled === true;
  checks[`${account.key}: memberships=${cycles.length} invoices=${invoices.length}`] =
    account.role === 'member' ? cycles.length === 1 && invoices.length === 1 : cycles.length === 0 && invoices.length === 0;
}
for (const [label, ok] of Object.entries(checks)) console.log((ok ? 'PASS: ' : 'FAIL: ') + label);
if (Object.values(checks).some(ok => !ok)) throw Error('Local fixture verification failed.');

await mkdir('.local', {recursive: true});
const file = path.resolve('.local/local-test-credentials.json');
await writeFile(file, JSON.stringify({
  stack: 'local supabase', apiUrl: url, createdAt: new Date().toISOString(),
  note: 'Disposable local fixtures. Reserved .invalid addresses; no mail is deliverable. Never reuse these anywhere else.',
  accounts: accounts.map(a => ({role: a.role, email: a.email, password: a.password, id: a.id}))
}, null, 2), {mode: 0o600});
if (process.platform === 'win32') {
  const locked = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`], {encoding: 'utf8'});
  if (locked.status !== 0) throw Error('Credentials saved, but the Windows ACL restriction failed. Restrict .local/local-test-credentials.json before continuing.');
}
console.log(`\nThree local accounts ready. Credentials saved only in ${file} (restricted, git-ignored).`);
console.log('No passwords were printed. The member invoice is intentionally unpaid so staff can record the first cash payment.');
