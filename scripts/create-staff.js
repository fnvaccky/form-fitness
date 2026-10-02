// Provisions an EXISTING Supabase Auth account as RepReady staff.
// It never creates, deletes or re-registers an Auth user, and it never touches a password.
// Run only after the staff role migration has been applied.
import {serviceClient, result} from '../src/supabase.js';
import {contacts} from '../src/validation.js';

const dryRun = process.argv.includes('--dry-run');
if (process.env.APP_WORKSPACE !== 'production') throw Error('Staff provisioning requires APP_WORKSPACE=production.');
if (new URL(process.env.SUPABASE_URL).hostname !== 'ivxbrhqqfgmhfpgpauzh.supabase.co') throw Error('Unexpected Supabase project. Refusing to provision.');
const info = contacts({name: process.env.STAFF_NAME, email: process.env.STAFF_EMAIL, phone: process.env.STAFF_PHONE});
const db = serviceClient();

const users = [];
for (let page = 1; ; page++) {
  const {data, error} = await db.auth.admin.listUsers({page, perPage: 1000});
  if (error) throw Error('Unable to list Auth users.');
  users.push(...data.users);
  if (data.users.length < 1000) break;
}
const user = users.find(u => u.email?.toLowerCase() === info.email);
if (!user) throw Error('No existing Auth account for that address. This script provisions an existing account and never creates one.');
const before = {id: user.id, createdAt: user.created_at};

// Re-check the preconditions rather than trusting them.
const existing = result(await db.from('ff_profiles').select('*').eq('id', user.id).maybeSingle());
if (existing && !(existing.workspace === 'production' && existing.role === 'staff')) {
  throw Error(`That account already has a ${existing.workspace} profile with role "${existing.role}". Review it manually; nothing was changed.`);
}
const memberships = result(await db.from('ff_memberships').select('id').eq('member_id', user.id));
const invoices = result(await db.from('ff_invoices').select('id').eq('member_id', user.id));
if (memberships.length || invoices.length) throw Error('That account already has membership or invoice records. Refusing to convert it to staff.');

console.log(JSON.stringify({email: info.email, authUserId: user.id, existingProfile: !!existing, memberships: memberships.length, invoices: invoices.length, mode: dryRun ? 'dry-run' : 'write'}, null, 2));
if (dryRun) { console.log('Dry run only. Nothing was written.'); process.exit(0); }

// Trusted metadata first: on its own it grants nothing, because ff_private.actor() reads ff_profiles.
// Neither password nor email is passed, so the existing credential is preserved exactly.
const updated = await db.auth.admin.updateUserById(user.id, {
  app_metadata: {...user.app_metadata, ff_workspace: 'production', ff_role: 'staff'},
  user_metadata: {...user.user_metadata, form_fitness: true, name: info.name, phone: info.phone}
});
if (updated.error) throw Error('Could not set trusted Auth metadata: ' + updated.error.message);

// register_auth_user fires only on INSERT into auth.users, so an existing account needs its profile
// written here. Nothing creates a membership or invoice: new_membership runs only for role 'member'.
if (!existing) {
  const {error} = await db.from('ff_profiles').insert({
    id: user.id, workspace: 'production', role: 'staff',
    name: info.name, email: info.email, phone: info.phone, enabled: true
  });
  if (error) throw Error(error.code === '23514'
    ? 'The database rejected role "staff". Apply the staff role migration first, then run this again. Auth metadata was set but grants no access on its own.'
    : 'Could not create the staff profile: ' + error.message);
} else {
  result(await db.from('ff_profiles').update({name: info.name, phone: info.phone, enabled: true}).eq('id', user.id));
}

const after = (await db.auth.admin.getUserById(user.id)).data.user;
const profile = result(await db.from('ff_profiles').select('*').eq('id', user.id).single());
const checks = {
  'Auth app_metadata.ff_role is staff': after.app_metadata?.ff_role === 'staff',
  'Auth app_metadata.ff_workspace is production': after.app_metadata?.ff_workspace === 'production',
  'Auth user_metadata.form_fitness is true': after.user_metadata?.form_fitness === true,
  'Auth user_metadata carries the staff name and phone': after.user_metadata?.name === info.name && after.user_metadata?.phone === info.phone,
  'ff_profiles role is staff': profile.role === 'staff',
  'ff_profiles workspace is production': profile.workspace === 'production',
  'ff_profiles is enabled': profile.enabled === true,
  'ff_profiles name, email and phone match': profile.name === info.name && profile.email === info.email && profile.phone === info.phone,
  'Auth metadata and ff_profiles agree': after.app_metadata?.ff_role === profile.role && after.app_metadata?.ff_workspace === profile.workspace,
  'No membership was created': result(await db.from('ff_memberships').select('id').eq('member_id', user.id)).length === 0,
  'No invoice was created': result(await db.from('ff_invoices').select('id').eq('member_id', user.id)).length === 0,
  'The original Auth account was preserved': after.id === before.id && after.created_at === before.createdAt
};
for (const [label, ok] of Object.entries(checks)) console.log((ok ? 'PASS: ' : 'FAIL: ') + label);
if (Object.values(checks).some(ok => !ok)) throw Error('Verification failed. Review the account before using it.');
console.log('Staff account provisioned. The existing password was not read, changed or printed.');
