import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {serviceClient,result} from '../src/supabase.js';
import {PASSWORD_MESSAGE} from '../public/password-rule.js';
// FEATURE-002 in a real browser: the show/hide button on every password field, and the checklist on the
// set and change password screens. Local stack only; the one account created here is deleted at the end.
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local tests only');
const env={...process.env,APP_ORIGIN:'',APP_WORKSPACE:'production',GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:''};
const server=createDevServer(env);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;
const db=serviceClient(),passed=[];let browser,userId;
const pass=name=>{passed.push(name);console.log('PASS: '+name);};
const email=`local-fields-${randomUUID().slice(0,8)}@example.invalid`;
let password='Fields9!'+randomBytes(18).toString('base64url');
// One password field as the person and a screen reader meet it.
const field=(page,id)=>page.evaluate(id=>{
 const input=document.getElementById(id),toggle=input.parentElement.querySelector('.password-toggle'),rules=document.getElementById(id+'-rules');
 return {type:input.type,autocomplete:input.getAttribute('autocomplete'),label:toggle?.getAttribute('aria-label'),pressed:toggle?.getAttribute('aria-pressed'),
  buttonType:toggle?.getAttribute('type'),focused:document.activeElement===input,caret:[input.selectionStart,input.selectionEnd],
  describedBy:input.getAttribute('aria-describedby'),checklist:rules?[...rules.querySelectorAll('li')].map(li=>li.dataset.met==='true'):null,
  spoken:rules?[...rules.querySelectorAll('li')].map(li=>li.textContent):null};
},id);
const toggleOf=(page,id)=>page.locator(`#${id}`).locator('xpath=..').locator('.password-toggle');
try{
 const made=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:'production',ff_role:'staff'},user_metadata:{form_fitness:true,name:'LOCAL TEST Fields',phone:'09170000032'}});
 assert.equal(made.error,null);userId=made.data.user.id;
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await (await browser.newContext()).newPage(),posts=[];
 page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
 await page.goto(origin);await page.locator('#login-password').waitFor();
 await page.evaluate(()=>{window.submits=0;window.addEventListener('submit',()=>window.submits++,true);});

 let state=await field(page,'login-password');
 assert.deepEqual([state.type,state.label,state.pressed,state.buttonType,state.checklist],['password','Show password','false','button',null]);
 assert.equal(await page.locator('.password-checklist').count(),0,'no checklist on the sign-in form');
 await page.locator('#login-password').fill('Secret9!word');
 await page.locator('#login-password').evaluate(input=>input.setSelectionRange(3,3));
 await toggleOf(page,'login-password').click();
 state=await field(page,'login-password');
 assert.deepEqual([state.type,state.label,state.pressed,state.focused,state.caret,state.autocomplete],['text','Hide password','true',true,[3,3],'current-password'],'a click shows it and keeps focus and the caret');
 await page.locator('#login-password').focus();await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.className),'password-toggle','Tab reaches the button');
 await page.keyboard.press('Space');state=await field(page,'login-password');
 assert.deepEqual([state.type,state.label,state.pressed],['password','Show password','false']);
 await page.keyboard.press('Enter');state=await field(page,'login-password');
 assert.deepEqual([state.type,state.pressed,state.autocomplete],['text','true','current-password']);
 assert.equal(await page.evaluate(()=>window.submits),0,'the button never submits');assert.deepEqual(posts,[]);
 pass('Sign-in: the eye button shows and hides by mouse and keyboard, keeps focus, caret and autocomplete, never submits; no checklist');

 await page.locator('#login-email').fill(email);
 const refused=page.waitForResponse(r=>r.url().endsWith('/api/login'));
 await page.getByRole('button',{name:/Log in/}).click();assert.equal((await refused).status(),401);
 state=await field(page,'login-password');assert.deepEqual([state.type,state.label,state.pressed],['password','Show password','false']);
 await page.locator('#login-password').fill(password);await toggleOf(page,'login-password').click();
 await page.getByRole('button',{name:/Log in/}).click();
 await page.getByRole('button',{name:'Change password'}).first().waitFor();
 pass('Submitting a form hides its passwords again');

 await page.getByRole('button',{name:'Change password'}).first().click();await page.locator('#updated-password').waitFor();
 assert.equal(await page.getByText('Use at least 12 characters').count(),0,'the old hint is gone');
 for(const id of ['current-password','updated-password']){state=await field(page,id);assert.deepEqual([state.type,state.label,state.pressed],['password','Show password','false'],id);}
 assert.equal((await field(page,'current-password')).checklist,null,'no checklist for the current password');
 assert.equal(await page.locator('#updated-password').getAttribute('minlength'),null,'no 12-character minimum');
 assert.equal(await page.locator('#updated-password').getAttribute('maxlength'),'72');
 state=await field(page,'updated-password');
 assert.deepEqual(state.checklist,[false,false,false,false,false]);assert.equal(state.describedBy,'updated-password-rules');
 for(const [keys,expected] of [['a',[false,false,true,false,false]],['A',[false,true,true,false,false]],['1',[false,true,true,true,false]],['!',[false,true,true,true,true]],['bcde',[true,true,true,true,true]]]){
  await page.locator('#updated-password').pressSequentially(keys);
  assert.deepEqual((await field(page,'updated-password')).checklist,expected,`after typing ${keys}`);
 }
 state=await field(page,'updated-password');
 assert.deepEqual(state.spoken,['8+ characters, met','Uppercase letter, met','Lowercase letter, met','Number, met','Symbol, met'],'each item says its state in words, not only by colour');
 await page.locator('#updated-password').fill('abcdefgh');
 assert.deepEqual((await field(page,'updated-password')).spoken.map(text=>text.endsWith('not met')),[false,true,false,true,true]);
 assert.equal(await page.locator('#updated-password').evaluate(input=>input.validationMessage),PASSWORD_MESSAGE,'the browser check uses the server message');
 const blocked=posts.length;await page.getByRole('button',{name:'Update password'}).click();
 assert.equal(posts.length,blocked,'a weak password is stopped before it leaves the browser');
 pass('Change password: both fields have the eye button; the new one ticks its checklist as you type and stops a weak password');

 const next='Fields9!'+randomBytes(6).toString('hex');
 await page.locator('#current-password').fill(password);await page.locator('#updated-password').fill(next);
 for(const id of ['current-password','updated-password'])await toggleOf(page,id).click();
 assert.deepEqual([(await field(page,'current-password')).type,(await field(page,'updated-password')).type],['text','text']);
 const saving=page.waitForResponse(r=>r.url().endsWith('/api/password')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Update password'}).click();
 assert.equal((await saving).status(),200);password=next;
 await page.locator('#updated-password').waitFor({state:'detached'});
 await page.getByRole('button',{name:'Change password'}).first().click();await page.locator('#updated-password').waitFor();
 for(const id of ['current-password','updated-password']){state=await field(page,id);assert.deepEqual([state.type,state.pressed],['password','false'],id);}
 await toggleOf(page,'current-password').click();await page.keyboard.press('Escape');
 await page.locator('#current-password').waitFor({state:'detached'});
 await page.getByRole('button',{name:'Change password'}).first().click();
 state=await field(page,'current-password');assert.deepEqual([state.type,state.pressed],['password','false']);
 await page.keyboard.press('Escape');
 pass('Passwords are hidden again after a successful change and after the dialog closes');

 const setup=await (await browser.newContext()).newPage();
 await setup.goto(`${origin}/api/auth/callback?token_hash=not-a-real-token&type=recovery`);await setup.locator('#setup-password').waitFor();
 state=await field(setup,'setup-password');
 assert.deepEqual([state.type,state.label,state.checklist],['password','Show password',[false,false,false,false,false]]);
 assert.equal(await setup.locator('#setup-password').getAttribute('minlength'),null);
 await setup.locator('#setup-password').pressSequentially('Abcdef1!');
 assert.deepEqual((await field(setup,'setup-password')).checklist,[true,true,true,true,true]);
 await toggleOf(setup,'setup-password').click();assert.equal((await field(setup,'setup-password')).type,'text');
 pass('Set password from a link: the same eye button and checklist');
}finally{
 await browser?.close();server.close();
 if(userId){result(await db.from('ff_profiles').delete().eq('id',userId));const {error}=await db.auth.admin.deleteUser(userId);if(error)throw Error('Test Auth cleanup failed.');}
 await mkdir('test-results',{recursive:true});await writeFile('test-results/password-fields-results.json',JSON.stringify({time:new Date().toISOString(),passed},null,2));
}
