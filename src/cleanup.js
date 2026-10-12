import {createHash,timingSafeEqual} from 'node:crypto';
import {serviceClient,result} from './supabase.js';
import {fail} from './validation.js';
import {closeCheckoutForCleanup} from './paymongo.js';
import {BUCKET} from './state.js';
// Task 10: deleting member accounts that never paid. The database decides who may delete and what
// (ff_private.account_cleanup for administrators, account_cleanup_auto for the daily job). First, every
// open online checkout is checked at PayMongo the way Cancel checkout does it: a payment that came in is
// settled and the delete refused; an unpaid session is expired before the account goes.
async function closeOpenCheckouts(open,env,origin){
 const db=serviceClient(env),expired=[];
 for(const item of open){
  const row=result(await db.from('ff_checkouts').select('*').eq('id',item.id).single());
  const closed=await closeCheckoutForCleanup(row,env,origin);
  if(closed.paid)fail('A payment came in for this account at PayMongo. It was recorded, so the account was not deleted.',409);
  expired.push({id:row.id,sessionId:closed.sessionId,providerStatus:closed.providerStatus,via:closed.via});
 }
 return expired;
}
// Best effort, after the account is gone: the member's photo and receipt images.
async function removeFiles(env,workspace,id){
 try{
  const storage=serviceClient(env).storage.from(BUCKET);
  for(const folder of ['photo','receipt']){
   const {data}=await storage.list(`${workspace}/${id}/${folder}`,{limit:100});
   if(data?.length)await storage.remove(data.map(file=>`${workspace}/${id}/${folder}/${file.name}`));
  }
 }catch{}
}
export async function deleteUnpaidAccount(client,body,env,origin){
 const id=String(body.id||'');
 const checked=result(await client.rpc('ff_account_cleanup',{action:'check',body:{id}}));
 if(checked.blockers.length)fail(checked.blockers[0],403);
 const expired=await closeOpenCheckouts(checked.openCheckouts,env,origin);
 const deleted=result(await client.rpc('ff_account_cleanup',{action:'delete',body:{id,expired}}));
 await removeFiles(env,env.APP_WORKSPACE||'production',id);
 return {deleted:deleted.deleted,checkoutsExpired:deleted.checkoutsExpired,message:'Account deleted. The email can be used again.'};
}
// Vercel Cron sends Authorization: Bearer CRON_SECRET. Compared as hashes, so the length isn't timed either.
export function cronAuthorized(header,secret){
 if(String(secret||'').length<16)return false;
 const hash=value=>createHash('sha256').update(String(value)).digest();
 return timingSafeEqual(hash(header||''),hash('Bearer '+secret));
}
// The daily job. It deletes nothing unless ACCOUNT_CLEANUP_ENABLED is "true", which is set only after
// Clark approves the list of accounts the first run would delete.
export async function runAutomaticCleanup(env,origin){
 const workspace=env.APP_WORKSPACE||'production',db=serviceClient(env);
 const due=result(await db.rpc('ff_account_cleanup_auto',{action:'due',body:{workspace}}));
 if(String(env.ACCOUNT_CLEANUP_ENABLED||'')!=='true')return {enabled:false,due:due.length,deleted:0,message:'Automatic clean-up is turned off.'};
 const outcome={enabled:true,due:due.length,deleted:0,kept:[]};
 for(const account of due){
  try{
   const expired=await closeOpenCheckouts(account.openCheckouts,env,origin);
   result(await db.rpc('ff_account_cleanup_auto',{action:'delete',body:{workspace,id:account.id,expired}}));
   await removeFiles(env,workspace,account.id);outcome.deleted++;
  }catch(error){outcome.kept.push({id:account.id,reason:error.message});}
 }
 return outcome;
}
