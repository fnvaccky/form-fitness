import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {serviceClient,result,configuration} from '../src/supabase.js';
import {contacts} from '../src/validation.js';
if(process.env.APP_WORKSPACE!=='production')throw Error('Owner setup requires APP_WORKSPACE=production.');
if(new URL(process.env.SUPABASE_URL).hostname!=='ivxbrhqqfgmhfpgpauzh.supabase.co')throw Error('Unexpected Supabase project.');
const {origin}=configuration();
const info=contacts({name:process.env.ADMIN_NAME,email:process.env.ADMIN_EMAIL,phone:process.env.ADMIN_PHONE});
const db=serviceClient();
const {data,error}=await db.auth.admin.createUser({email:info.email,password:'Owner9!'+randomBytes(32).toString('base64url'),email_confirm:false,app_metadata:{ff_workspace:'production',ff_role:'admin'},user_metadata:{form_fitness:true,...info}});
if(error)throw Error('Admin creation failed. Existing users are never overwritten; inspect the Auth dashboard.');
const profile=result(await db.from('ff_profiles').select('role,workspace').eq('id',data.user.id).single());
if(profile.role!=='admin'||profile.workspace!=='production')throw Error('Admin provisioning mismatch; do not use this account until reviewed.');
const link=await db.auth.admin.generateLink({type:'recovery',email:info.email,options:{redirectTo:origin}});
if(link.error)throw Error('Admin created, but setup link failed. Generate a new recovery link securely through Auth administration.');
await mkdir('.local',{recursive:true});
const file=path.resolve('.local/admin-setup.json');
await writeFile(file,JSON.stringify({email:info.email,setupUrl:origin+'/#/set-password?type=recovery&token_hash='+encodeURIComponent(link.data.properties.hashed_token)},null,2),{mode:0o600});
if(process.platform==='win32'){
 const locked=spawnSync('icacls',[file,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{encoding:'utf8'});
 if(locked.status!==0)throw Error('Restrict .local/admin-setup.json permissions before continuing.');
}
console.log('Owner created. One-time setup link saved privately in .local/admin-setup.json. No email sent.');
