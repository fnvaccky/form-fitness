import {createClient} from '@supabase/supabase-js';
import {result} from '../src/supabase.js';
import {contacts,startDate} from '../src/validation.js';
// Paid-first registrations saved before Task 10. Add member no longer makes them, but rows that already
// exist must still finish through /registration-payment, /registration-fulfill and PayMongo. The suites
// make them the way the old /members route did: ff_registration('create') as the signed-in staff member.
export async function legacyRegistration(account,details){
 const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 result(await client.auth.signInWithPassword({email:account.email,password:account.password}));
 try{
  const info=contacts(details);startDate(details.start);
  return {registration:result(await client.rpc('ff_registration',{action:'create',body:{...info,goal:details.goal,plan:details.plan,start:details.start,requestId:details.requestId}}))};
 }finally{await client.auth.signOut({scope:'local'});}
}
