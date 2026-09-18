import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { parseCookie, stringifySetCookie } from 'cookie';
import { fail } from './validation.js';

export function configuration(env = process.env) {
  const configuredOrigin=env.APP_ORIGIN || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '');
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !configuredOrigin) fail('Supabase runtime configuration is missing. See DEPLOYMENT.md.', 503);
  const origin = new URL(configuredOrigin).origin;
  if (origin !== configuredOrigin) fail('APP_ORIGIN must be an exact origin without a trailing slash.', 503);
  if (!['production', 'demo'].includes(env.APP_WORKSPACE || 'production')) fail('APP_WORKSPACE is invalid.', 503);
  if (env.VERCEL && !origin.startsWith('https://')) fail('The deployment requires an HTTPS origin.', 503);
  return { origin, workspace: env.APP_WORKSPACE || 'production' };
}
export function serverClient(req, res, env = process.env) {
  const { origin } = configuration(env);
  const cookies = parseCookie(req.headers.cookie || '');
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookieOptions: { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/' },
    cookies: {
      getAll: () => Object.entries(cookies).map(([name, value]) => ({ name, value })),
      setAll(items) {
        const prior = res.getHeader('Set-Cookie') || [];
        res.setHeader('Set-Cookie', [...(Array.isArray(prior) ? prior : [prior]), ...items.map(({ name, value, options }) => {
          cookies[name] = value;
          return stringifySetCookie({ ...options, name, value, httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/' });
        })]);
      }
    }
  });
}
export function serviceClient(env = process.env) {
  if (!env.SUPABASE_SECRET_KEY) fail('Server-side Auth administration is not configured. See DEPLOYMENT.md.', 503);
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
export function result({ data, error }) {
  if (error) {
    if (error.code === '42501') fail(error.message.includes('Administrator') ? error.message : 'Access denied. Sign in to an authorized account.', 403);
    if (error.code === '23505') fail('That reference, request, or account already exists. Refresh before trying again.', 409);
    if (error.code === 'P0001') fail(error.message, /already|overlap|remaining balance/.test(error.message) ? 409 : 400);
    if (/^22|^23/.test(error.code || '')) fail('Invalid details. Check the required fields and selected records.');
    fail('The database request could not be completed.', 502);
  }
  return data;
}
export async function allRows(client, table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = result(await client.from(table).select('*').order('id').range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
