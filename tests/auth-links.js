import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {serviceClient,result} from '../src/supabase.js';
// BUG-011 in a real browser: link scanners open setup links before people do. Local stack only. The app
// runs in-process on a free port, and the one account created here is deleted at the end.
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local tests only');
const env={...process.env,APP_ORIGIN:'',APP_WORKSPACE:'production',GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:''};
const server=createDevServer(env);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;
const db=serviceClient(),passed=[];let browser,userId;
const pass=name=>{passed.push(name);console.log('PASS: '+name);};
const email=`local-link-${randomUUID().slice(0,8)}@example.invalid`;
const login=password=>fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
try{
 const made=await db.auth.admin.createUser({email,password:'Link9!'+randomBytes(24).toString('base64url'),email_confirm:true,
  app_metadata:{ff_workspace:'production',ff_role:'staff'},user_metadata:{form_fitness:true,name:'LOCAL TEST Link',phone:'09170000031'}});
 assert.equal(made.error,null);userId=made.data.user.id;
 const generated=await db.auth.admin.generateLink({type:'recovery',email});assert.equal(generated.error,null);
 const tokenHash=generated.data.properties.hashed_token,link=`${origin}/api/auth/callback?token_hash=${tokenHash}&type=recovery`;
 browser=await chromium.launch({channel:'msedge',headless:true});
 // Scanners: a plain fetch, then a browser that runs the page's scripts, on the link and on the root-path fallback.
 assert.equal((await fetch(link,{redirect:'manual'})).status,303);
 for(const url of [link,`${origin}/?token_hash=${tokenHash}&type=recovery`]){
  const scan=await browser.newContext(),page=await scan.newPage();
  await page.goto(url);await page.getByRole('button',{name:'Save password',exact:true}).waitFor();
  assert.equal(page.url(),origin+'/#/set-password','the token is gone from the address bar');
  await scan.close();
 }
 pass('Scanners that fetch the link or render it (also through the root-path fallback) only reach the set-password form');

 const person=await browser.newContext(),page=await person.newPage(),carried=[];
 page.on('request',r=>{if((r.url()+(r.postData()||'')).includes(tokenHash))carried.push(`${r.method()} ${new URL(r.url()).pathname}`);});
 await page.goto(link);await page.getByRole('button',{name:'Save password',exact:true}).waitFor();
 assert.equal(page.url(),origin+'/#/set-password');
 assert(!(await page.content()).includes(tokenHash),'the token is never written into the page');
 const newPassword='LocalLink2026!'+randomUUID().slice(0,6);
 await page.getByLabel('New password *',{exact:true}).fill(newPassword);
 const saving=page.waitForResponse(r=>r.url().endsWith('/api/auth/verify')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Save password',exact:true}).click();
 const saved=await saving;assert.equal(saved.status(),200,(await saved.json()).error);
 await page.locator('#toast.show').filter({hasText:'Password saved.'}).waitFor();
 const session=await (await page.request.get(origin+'/api/session')).json();
 assert.equal(session.user.email,email);assert.equal(session.user.role,'staff');
 assert.deepEqual(carried,['GET /api/auth/callback','POST /api/auth/verify'],'after the email link itself, only Save password carries the token');
 pass('The person opens the link afterwards: no token in the address bar or page, and Save password verifies it and signs them in');

 const again=await browser.newContext(),reuse=await again.newPage();
 await reuse.goto(link);await reuse.getByLabel('New password *',{exact:true}).fill('LocalLinkReuse2026!');
 const reusing=reuse.waitForResponse(r=>r.url().endsWith('/api/auth/verify')&&r.request().method()==='POST');
 await reuse.getByRole('button',{name:'Save password',exact:true}).click();
 assert.equal((await reusing).status(),410);
 await reuse.getByText('This link expired or was already used — request a new one',{exact:false}).waitFor();
 await reuse.getByRole('button',{name:'Forgot password',exact:true}).click();
 await reuse.getByRole('heading',{name:'Reset your password'}).waitFor();
 assert.equal(await reuse.getByLabel('Email address *',{exact:true}).isVisible(),true);
 pass('The used link shows "This link expired or was already used — request a new one", and its button opens Forgot password');

 assert.equal((await login(newPassword)).status,200);assert.equal((await login('LocalLinkReuse2026!')).status,401);
 pass('The first saved password signs in; the second attempt changed nothing');
}finally{
 await browser?.close();server.close();
 if(userId){result(await db.from('ff_profiles').delete().eq('id',userId));const {error}=await db.auth.admin.deleteUser(userId);if(error)throw Error('Test Auth cleanup failed.');}
 await mkdir('test-results',{recursive:true});await writeFile('test-results/auth-links-results.json',JSON.stringify({time:new Date().toISOString(),passed},null,2));
}
