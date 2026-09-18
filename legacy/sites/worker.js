import { gmailSMTP } from './mail.js';

const encoder = new TextEncoder();
const PLANS = { basic: { name: 'Essential', price: 89900 }, plus: { name: 'Momentum', price: 149900 }, elite: { name: 'Performance', price: 249900 } };
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);
const id = prefix => prefix + '-' + crypto.randomUUID().slice(0, 12).toUpperCase();
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dbAll = async (db, sql, ...values) => (await db.prepare(sql).bind(...values).all()).results;
const dbGet = (db, sql, ...values) => db.prepare(sql).bind(...values).first();
const dbRun = (db, sql, ...values) => db.prepare(sql).bind(...values).run();
const parse = row => row ? JSON.parse(row.data) : null;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (message, status = 400) => { throw new HttpError(status, message); };
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const cookie = (token, maxAge = 28800) => `form_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
let schema;
async function init(db) {
  if (!db) fail('The membership database is not available.', 503);
  schema ??= db.exec(`
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,member_id TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY,member_id TEXT NOT NULL,amount INTEGER NOT NULL,paid INTEGER NOT NULL DEFAULT 0 CHECK(paid >= 0 AND paid <= amount),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,member_id TEXT NOT NULL,amount INTEGER NOT NULL,reference_key TEXT UNIQUE,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,member_id TEXT NOT NULL,reference_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkins (id TEXT PRIMARY KEY,member_id TEXT NOT NULL,qr_nonce TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created INTEGER NOT NULL,sent INTEGER);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS member_invoices ON invoices(member_id);
CREATE INDEX IF NOT EXISTS member_payments ON payments(member_id);
CREATE INDEX IF NOT EXISTS member_checkins ON checkins(member_id,created);
CREATE INDEX IF NOT EXISTS email_queue ON outbox(status,created);
CREATE TRIGGER IF NOT EXISTS prevent_overpayment BEFORE INSERT ON payments BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND member_id=NEW.member_id AND paid+NEW.amount<=amount AND NEW.amount>0) THEN RAISE(ABORT,'invalid_payment') END; END;
CREATE TRIGGER IF NOT EXISTS update_invoice_balance AFTER INSERT ON payments BEGIN UPDATE invoices SET paid=paid+NEW.amount WHERE id=NEW.invoice_id; END;
`).catch(e => { schema = null; throw e; });
  await schema;
}
function contacts(body) {
  const name = String(body.name || '').trim(), email = String(body.email || '').trim().toLowerCase(), phone = String(body.phone || '').replace(/[\s()-]/g, '');
  if (name.length < 2 || name.length > 70 || /[<>\r\n]/.test(name)) fail('Enter a full name between 2 and 70 characters.');
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email) || email.length > 100) fail('Enter a valid email address.');
  if (!/^(09\d{9}|\+639\d{9})$/.test(phone)) fail('Mobile number is required. Use 09XXXXXXXXX or +639XXXXXXXXX.');
  return { name, email, phone: phone.startsWith('+63') ? '0' + phone.slice(3) : phone };
}
function validatePassword(password) { if (typeof password !== 'string' || password.length < 12 || password.length > 128 || !/[a-z]/i.test(password) || !/\d/.test(password)) fail('Use 12–128 characters with at least one letter and one number.'); }
async function passwordHash(password, salt) { const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']); return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: encoder.encode(salt) }, key, 256)); }
function equal(a, b) { if (a.length !== b.length) return false; let n = 0; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i); return n === 0; }
async function rateLimit(db, key, limit = 20) { const slot = Math.floor(now() / 600), k = `${key}:${slot}`; const row = await db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(k, now() + 1200).first(); if (row.count > limit) fail('Too many attempts. Try again in 10 minutes.', 429); }
async function sessionUser(request, env) {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)form_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  const row = await dbGet(env.DB, 'SELECT user_id FROM sessions WHERE token_hash=? AND expires>?', await digest(token), now());
  if (!row) return null;
  if (row.user_id === 'owner') return { id: 'owner', role: 'admin', name: 'Gym administrator', email: env.OWNER_EMAIL };
  const account = await dbGet(env.DB, 'SELECT id,email,member_id FROM accounts WHERE id=?', row.user_id);
  if (!account) return null;
  const member = parse(await dbGet(env.DB, 'SELECT data FROM members WHERE id=?', account.member_id));
  return { id: account.id, role: 'member', memberId: account.member_id, name: member.name, email: account.email };
}
async function createSession(env, userId) { const token = random(); await dbRun(env.DB, 'INSERT INTO sessions VALUES(?,?,?)', await digest(token), userId, now() + 28800); return cookie(token); }
async function setting(env, key) { const row = await dbGet(env.DB, 'SELECT value FROM settings WHERE key=?', key); return row ? JSON.parse(row.value) : null; }
async function saveSetting(env, key, value) { await dbRun(env.DB, 'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
async function secretKey(env) { if (!env.APP_SECRET || env.APP_SECRET.length < 32) fail('Secure configuration is missing.', 503); return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(env.APP_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(env, value) { const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(env), encoder.encode(value)); return b64(iv) + '.' + b64(encrypted); }
async function unseal(env, value) { const [iv, text] = value.split('.'); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await secretKey(env), unb64(text))); }
async function queueEmail(env, recipient, subject, body) { await dbRun(env.DB, 'INSERT INTO outbox(id,recipient,subject,body,status,created) VALUES(?,?,?,?,?,?)', id('MAIL'), recipient, subject, body + '\n\nFORM Fitness · Membership services', 'queued', now()); }
async function flushEmails(env) {
  const config = await setting(env, 'gmail'); if (!config) return;
  const sender = { address: config.address, password: await unseal(env, config.secret) };
  const rows = await dbAll(env.DB, "SELECT * FROM outbox WHERE status='queued' ORDER BY created LIMIT 8");
  for (const row of rows) {
    const claim = await dbRun(env.DB, "UPDATE outbox SET status='sending' WHERE id=? AND status='queued'", row.id); if (!claim.meta.changes) continue;
    try { await gmailSMTP(sender, row); await dbRun(env.DB, "UPDATE outbox SET status='sent',sent=?,error=NULL WHERE id=?", now(), row.id); }
    catch { await dbRun(env.DB, "UPDATE outbox SET status='needs_review',error=? WHERE id=?", 'Delivery was not confirmed. Check Gmail Sent before retrying.', row.id); }
  }
}
function beginMail(env, ctx) { ctx.waitUntil(flushEmails(env).catch(() => {})); }
function cleanImage(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 900000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)) fail('Upload a PNG, JPEG, or WebP image under 650 KB.');
  const bytes = unb64(value.split(',')[1]); const valid = value.startsWith('data:image/png;') ? bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 : value.startsWith('data:image/jpeg;') ? bytes[0] === 255 && bytes[1] === 216 : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!valid) fail('The uploaded image format does not match its content.'); return value;
}
async function stateFor(env, user) {
  const admin = user.role === 'admin', where = admin ? '' : ' WHERE member_id=?', args = admin ? [] : [user.memberId];
  const members = (await dbAll(env.DB, 'SELECT data FROM members' + (admin ? '' : ' WHERE id=?'), ...args)).map(parse);
  const invoices = (await dbAll(env.DB, 'SELECT data FROM invoices' + where, ...args)).map(parse);
  const payments = (await dbAll(env.DB, 'SELECT data FROM payments' + where, ...args)).map(parse);
  const submissions = (await dbAll(env.DB, 'SELECT data,status FROM submissions' + where, ...args)).map(r => ({ ...parse(r), status: r.status }));
  const checkins = (await dbAll(env.DB, 'SELECT data FROM checkins' + where + ' ORDER BY created DESC LIMIT 50', ...args)).map(parse);
  const gmail = admin ? await setting(env, 'gmail') : null;
  const outbox = admin ? await dbAll(env.DB, 'SELECT id,recipient,subject,status,error,created,sent FROM outbox ORDER BY created DESC LIMIT 30') : [];
  return { user, date: today(), members, invoices, payments, submissions, checkins, activity: [], settings: { payments: await setting(env, 'payments') || {}, email: admin ? { connected: !!gmail, address: gmail?.address || '' } : null }, outbox };
}
async function register(body, env) {
  const info = contacts(body); validatePassword(body.password);
  if (!PLANS[body.plan]) fail('Select a valid membership plan.');
  const start = body.start || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start)) || new Date(start).toISOString().slice(0, 10) !== start || start < today() || start > addDays(today(), 365)) fail('Choose a valid start date within the next year.');
  const memberId = id('FM'), accountId = id('USER'), invoiceId = id('INV'), salt = random();
  const member = { id: memberId, ...info, plan: body.plan, start, end: addDays(start, 29), joined: today(), goal: ['Improve fitness', 'Build strength', 'Stay consistent', 'Manage weight'].includes(body.goal) ? body.goal : 'Improve fitness', photo: '' };
  const invoice = { id: invoiceId, memberId, plan: body.plan, amount: PLANS[body.plan].price / 100, start, end: member.end, due: start, created: today() };
  const hash = await passwordHash(body.password, salt);
  try { await env.DB.batch([
    env.DB.prepare('INSERT INTO members VALUES(?,?,?)').bind(memberId, info.email, JSON.stringify(member)),
    env.DB.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').bind(accountId, info.email, memberId, salt, hash, now()),
    env.DB.prepare('INSERT INTO invoices(id,member_id,amount,paid,data) VALUES(?,?,?,0,?)').bind(invoiceId, memberId, PLANS[body.plan].price, JSON.stringify(invoice))
  ]); } catch (e) { if (String(e).includes('UNIQUE')) fail('An account with this email already exists.', 409); throw e; }
  await queueEmail(env, info.email, 'Welcome to FORM Fitness', `Hi ${info.name},\n\nYour ${PLANS[body.plan].name} membership has been registered.\nMember ID: ${memberId}\nDates: ${start} to ${member.end}\nAmount due: PHP ${invoice.amount.toFixed(2)}\n\nLog in to view your invoice. Your membership activates when payment is confirmed and your start date is reached.`);
  return { member, invoice, accountId };
}
function cents(value) { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) fail('Enter a positive payment amount with no more than two decimal places.'); return Math.round(value * 100); }
async function recordPayment(body, env, submission = null) {
  const inv = await dbGet(env.DB, 'SELECT * FROM invoices WHERE id=?', body.invoiceId); if (!inv) fail('Invoice not found.', 404);
  const amount = cents(body.amount); if (amount > inv.amount - inv.paid) fail('Payment exceeds the remaining balance.');
  if (!['Cash', 'GCash', 'Bank transfer'].includes(body.method)) fail('Choose a valid payment method.');
  const reference = String(body.reference || '').trim(); if (body.method !== 'Cash' && !/^[a-z0-9 -]{6,80}$/i.test(reference)) fail('Enter a valid transaction reference of 6–80 characters.');
  const date = body.date || today(), invoice = parse(inv); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < invoice.created || date > today()) fail('Choose a payment date between invoice creation and today.');
  const member = parse(await dbGet(env.DB, 'SELECT data FROM members WHERE id=?', inv.member_id));
  const payment = { id: id('PAY'), invoiceId: inv.id, memberId: inv.member_id, amount: amount / 100, method: body.method, reference, date };
  if (body.method === 'Cash' && !/^[a-f0-9-]{36}$/.test(body.idempotencyKey || '')) fail('Payment request ID is missing. Reopen the payment form.');
  const refKey = body.method === 'Cash' ? 'CASH:' + body.idempotencyKey : body.method + ':' + reference.replace(/[ -]/g, '').toUpperCase();
  const queries = [env.DB.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?)').bind(payment.id, inv.id, inv.member_id, amount, refKey, JSON.stringify(payment))];
  if (submission) queries.push(env.DB.prepare("UPDATE submissions SET status='approved' WHERE id=? AND status='pending'").bind(submission.id));
  try { await env.DB.batch(queries); } catch (e) { if (/UNIQUE|invalid_payment|CHECK/.test(String(e))) fail('This payment was already recorded or the remaining balance changed. Refresh and check the invoice.', 409); throw e; }
  await queueEmail(env, member.email, 'FORM Fitness payment confirmed', `Hi ${member.name},\n\nWe confirmed your payment of PHP ${payment.amount.toFixed(2)} by ${payment.method}.\nReceipt: ${payment.id}\nInvoice: ${inv.id}\nRemaining balance: PHP ${((inv.amount - inv.paid - amount) / 100).toFixed(2)}\n\nThank you for being part of FORM Fitness.`);
  return payment;
}
async function qrKey(env) { return crypto.subtle.importKey('raw', encoder.encode(env.APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function qrToken(env, memberId) { const payload = btoa(JSON.stringify({ memberId, exp: now() + 90, nonce: random().slice(0, 32) })); const signature = b64(await crypto.subtle.sign('HMAC', await qrKey(env), encoder.encode(payload))); return { token: 'FORM1.' + payload + '.' + signature, expires: now() + 90 }; }
async function verifyQR(env, token) {
  if (typeof token !== 'string' || token.length > 1000) fail('This is not a valid FORM member pass.');
  let payload; try { const [version, text, signature, extra] = token.split('.'); if (version !== 'FORM1' || extra || !await crypto.subtle.verify('HMAC', await qrKey(env), unb64(signature), encoder.encode(text))) fail('Invalid QR signature.'); payload = JSON.parse(atob(text)); } catch { fail('This QR code is not a valid FORM member pass.'); }
  if (!Number.isInteger(payload.exp) || payload.exp < now() || payload.exp > now() + 95) fail('This pass has expired. Ask the member to refresh their QR code.');
  if (await dbGet(env.DB, 'SELECT id FROM checkins WHERE qr_nonce=?', payload.nonce)) fail('This pass was already used. Ask the member to refresh it.', 409);
  const member = parse(await dbGet(env.DB, 'SELECT data FROM members WHERE id=?', payload.memberId)); if (!member) fail('Member not found.', 404);
  const inv = await dbGet(env.DB, 'SELECT * FROM invoices WHERE member_id=? ORDER BY rowid DESC LIMIT 1', member.id);
  if (member.start > today() || member.end < today() || !inv || inv.paid < inv.amount) fail('Check-in denied: this membership is not active.');
  return { member, payload };
}
async function handle(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  await init(env.DB);
  if (!['GET', 'POST'].includes(request.method)) fail('Method not allowed.', 405);
  if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) fail('Request origin is not allowed.', 403);
  let body = {};
  if (request.method === 'POST') {
    if (Number(request.headers.get('Content-Length') || 0) > 1900000) fail('Upload is too large.', 413);
    if (!request.headers.get('content-type')?.includes('application/json')) fail('Use a JSON request.', 415);
    const text = await request.text(); if (text.length > 1900000) fail('Upload is too large.', 413);
    try { body = JSON.parse(text); } catch { fail('Invalid JSON request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid request body.');
  }
  const isOwner = request.headers.get('oai-authenticated-user-id') === env.OWNER_ID && !!env.OWNER_ID;
  const user = await sessionUser(request, env);
  if (path === '/api/session' && request.method === 'GET') return json({ user, canOwnerLogin: isOwner, date: today() });
  if (path === '/api/owner-login' && request.method === 'POST') { if (!isOwner) fail('Only the private site owner can sign in as administrator.', 403); return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, 'owner') }); }
  if (path === '/api/logout' && request.method === 'POST') { const token = request.headers.get('cookie')?.match(/form_session=([a-f0-9]{64})/)?.[1]; if (token) await dbRun(env.DB, 'DELETE FROM sessions WHERE token_hash=?', await digest(token)); return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) }); }
  if (path === '/api/signup' && request.method === 'POST') { await rateLimit(env.DB, 'signup:' + (request.headers.get('CF-Connecting-IP') || 'private'), 10); const result = await register(body, env); beginMail(env, ctx); return json({ memberId: result.member.id }, 201, { 'Set-Cookie': await createSession(env, result.accountId) }); }
  if (path === '/api/login' && request.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase(); await rateLimit(env.DB, 'login:' + (request.headers.get('CF-Connecting-IP') || 'private') + ':' + await digest(email), 10);
    if (typeof body.password !== 'string' || body.password.length > 128) fail('Email or password is incorrect.', 401);
    const account = await dbGet(env.DB, 'SELECT * FROM accounts WHERE email=?', email);
    const hash = await passwordHash(body.password, account?.salt || 'invalid-account-padding-salt');
    if (!account || !equal(hash, account.password_hash)) fail('Email or password is incorrect.', 401);
    return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, account.id) });
  }
  if (!user) fail('Please log in to continue.', 401);
  const admin = () => { if (user.role !== 'admin') fail('Administrator access is required.', 403); };
  if (path === '/api/state' && request.method === 'GET') return json(await stateFor(env, user));
  if (path === '/api/members' && request.method === 'POST') { admin(); const result = await register(body, env); beginMail(env, ctx); return json({ member: result.member, invoice: result.invoice }, 201); }
  if (path === '/api/profile' && request.method === 'POST') {
    if (user.role !== 'member') fail('Sign in to a member account to edit its profile.');
    const member = parse(await dbGet(env.DB, 'SELECT data FROM members WHERE id=?', user.memberId));
    if (String(body.email || '').toLowerCase() !== member.email) fail('Email changes require administrator assistance.');
    const info = contacts(body); Object.assign(member, info, { goal: ['Improve fitness', 'Build strength', 'Stay consistent', 'Manage weight'].includes(body.goal) ? body.goal : member.goal });
    if (body.photo !== undefined) member.photo = cleanImage(body.photo);
    await dbRun(env.DB, 'UPDATE members SET data=? WHERE id=?', JSON.stringify(member), member.id); return json({ ok: true });
  }
  if (path === '/api/password' && request.method === 'POST') {
    if (user.role !== 'member') fail('Use your ChatGPT account settings to manage owner sign-in.');
    validatePassword(body.newPassword); const account = await dbGet(env.DB, 'SELECT * FROM accounts WHERE id=?', user.id);
    if (!equal(await passwordHash(String(body.currentPassword || ''), account.salt), account.password_hash)) fail('Current password is incorrect.', 401);
    const salt = random(); await env.DB.batch([env.DB.prepare('UPDATE accounts SET salt=?,password_hash=? WHERE id=?').bind(salt, await passwordHash(body.newPassword, salt), user.id), env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id)]);
    return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, user.id) });
  }
  if (path === '/api/payments' && request.method === 'POST') { admin(); if (body.verified !== true) fail('Confirm you have verified the payment before recording it.'); const payment = await recordPayment(body, env); beginMail(env, ctx); return json({ payment }, 201); }
  if (path === '/api/payment-submissions' && request.method === 'POST') {
    if (user.role !== 'member') fail('Sign in as the paying member.');
    const inv = await dbGet(env.DB, 'SELECT * FROM invoices WHERE id=? AND member_id=?', body.invoiceId, user.memberId); if (!inv) fail('Invoice not found.', 404);
    const amount = cents(body.amount); if (amount > inv.amount - inv.paid) fail('Amount exceeds the remaining balance.');
    const method = body.method; if (!['GCash', 'Bank transfer'].includes(method)) fail('Choose GCash or bank transfer.');
    const paymentSettings = await setting(env, 'payments'); if (!paymentSettings?.[method === 'GCash' ? 'gcash' : 'bank']?.image) fail('This payment method has not been set up by your gym.');
    const reference = String(body.reference || '').trim(); if (!/^[a-z0-9 -]{6,80}$/i.test(reference)) fail('Enter the real transaction reference, 6–80 characters.');
    const refKey = method + ':' + reference.replace(/[ -]/g, '').toUpperCase();
    if (await dbGet(env.DB, 'SELECT id FROM payments WHERE reference_key=?', refKey)) fail('That transaction reference has already been used.', 409);
    const submission = { id: id('SUB'), invoiceId: inv.id, memberId: user.memberId, amount: amount / 100, method, reference, date: today(), status: 'pending', receipt: cleanImage(body.receipt || '') };
    try { await dbRun(env.DB, 'INSERT INTO submissions VALUES(?,?,?,?,?,?)', submission.id, inv.id, user.memberId, refKey, 'pending', JSON.stringify(submission)); } catch(e) { if (String(e).includes('UNIQUE')) fail('That reference has already been submitted.', 409); throw e; }
    await queueEmail(env, env.OWNER_EMAIL, 'FORM Fitness payment awaiting review', `A member submitted ${method} payment reference ${reference} for PHP ${submission.amount.toFixed(2)}.\nInvoice: ${inv.id}\n\nLog in as administrator and verify the transaction in your own GCash or bank account before approval.`);
    beginMail(env, ctx); return json({ submission }, 201);
  }
  if (path === '/api/review-payment' && request.method === 'POST') {
    admin(); const row = await dbGet(env.DB, "SELECT * FROM submissions WHERE id=? AND status='pending'", body.id); if (!row) fail('This payment was already reviewed or is unavailable.', 409);
    const sub = parse(row);
    if (body.approve === true) { if (body.verified !== true) fail('Confirm receipt of the funds first.'); await recordPayment({ ...sub, date: today() }, env, sub); }
    else { await dbRun(env.DB, "UPDATE submissions SET status='rejected' WHERE id=? AND status='pending'", sub.id); const member = parse(await dbGet(env.DB, 'SELECT data FROM members WHERE id=?', sub.memberId)); await queueEmail(env, member.email, 'FORM Fitness payment needs attention', `Your payment reference ${sub.reference} could not be confirmed. Please contact the gym before sending another payment.`); }
    beginMail(env, ctx); return json({ ok: true });
  }
  if (path === '/api/qr' && request.method === 'GET') { if (user.role !== 'member') fail('Member passes are available only to the signed-in member.', 403); return json(await qrToken(env, user.memberId)); }
  if (path === '/api/scan' && request.method === 'POST') { admin(); const result = await verifyQR(env, body.token); return json({ member: result.member, expires: result.payload.exp }); }
  if (path === '/api/check-in' && request.method === 'POST') {
    admin(); if (body.confirmed !== true) fail('Match the member to their photo or photo ID first.'); const { member, payload } = await verifyQR(env, body.token);
    const checkin = { id: id('IN'), memberId: member.id, name: member.name, date: today(), timestamp: new Date().toISOString() };
    try { await dbRun(env.DB, 'INSERT INTO checkins VALUES(?,?,?,?,?)', checkin.id, member.id, payload.nonce, now(), JSON.stringify(checkin)); } catch(e) { if (String(e).includes('UNIQUE')) fail('This pass has already been used.', 409); throw e; }
    await queueEmail(env, member.email, 'FORM Fitness check-in confirmed', `Hi ${member.name},\n\nYour gym check-in was confirmed at ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} (Philippines time).\nMember ID: ${member.id}\n\nIf this was not you, contact your gym administrator.`);
    beginMail(env, ctx); return json({ checkin }, 201);
  }
  if (path === '/api/settings/payments' && request.method === 'POST') {
    admin(); const result = {};
    for (const key of ['gcash', 'bank']) { const item = body[key] || {}; if (item.image) { const name = String(item.name || '').trim(), detail = String(item.detail || '').trim(); if (name.length < 2 || name.length > 100 || /[<>\r\n]/.test(name)) fail('Enter the recipient account name for each uploaded QR.'); if (detail.length > 120 || /[<>\r\n]/.test(detail)) fail('Payment details are too long or invalid.'); result[key] = { image: cleanImage(item.image), name, detail }; } }
    await saveSetting(env, 'payments', result); return json({ ok: true });
  }
  if (path === '/api/settings/email' && request.method === 'POST') {
    admin(); if (body.disconnect) { await dbRun(env.DB, "DELETE FROM settings WHERE key='gmail'"); return json({ ok: true }); }
    const address = String(body.address || '').trim().toLowerCase(), password = String(body.appPassword || '').replace(/\s/g, '');
    if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(address) || !/^[a-z0-9]{16}$/i.test(password)) fail('Enter your Gmail address and its 16-character Google app password.');
    try { await gmailSMTP({ address, password }); } catch(e) { fail(e.message?.startsWith('Gmail rejected') ? e.message : 'Could not authenticate with Gmail. Check your app password, 2-Step Verification, and account eligibility.', 422); }
    await saveSetting(env, 'gmail', { address, secret: await seal(env, password) });
    await queueEmail(env, address, 'FORM Fitness email connection confirmed', 'Gmail notifications are now configured for membership registration, confirmed payments, and verified check-ins.');
    beginMail(env, ctx); return json({ ok: true });
  }
  if (path === '/api/email-retry' && request.method === 'POST') { admin(); if (!await setting(env, 'gmail')) fail('Connect Gmail in Settings first.'); if (body.id) { if (body.checked !== true) fail('Check Gmail Sent for this message before retrying.'); await dbRun(env.DB, "UPDATE outbox SET status='queued',error=NULL WHERE id=? AND status='needs_review'", body.id); } beginMail(env, ctx); return json({ ok: true }); }
  fail('Endpoint not found.', 404);
}
export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch(e) { if (e instanceof HttpError) return json({ error: e.message }, e.status); console.error('FORM request failed:', e.name); return json({ error: 'The request could not be completed. Please try again.' }, 500); }
  }
};
