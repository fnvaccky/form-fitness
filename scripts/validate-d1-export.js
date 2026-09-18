import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function validateExport(source){
 const tables=['members','invoices','payments','submissions','checkins','outbox','settings'];
 for(const table of tables)if(!Array.isArray(source[table]))throw Error('Missing table: '+table);
 if(source.accounts||source.sessions)throw Error('Exclude password hashes and sessions from the transfer manifest. Account transition uses invitations.');
 const decoded={};for(const table of tables)decoded[table]=source[table].map(row=>row.data?{...row,record:JSON.parse(row.data)}:{...row,record:row});
 const members=new Set(source.members.map(m=>m.id));
 const invoices=new Map(source.invoices.map(i=>[i.id,i]));
 for(const table of tables){const ids=source[table].map(r=>r.id??r.key);if(new Set(ids).size!==ids.length)throw Error('Duplicate primary key in '+table);}
 for(const i of source.invoices){if(!members.has(i.member_id)||!Number.isSafeInteger(i.amount)||i.amount<=0||!Number.isSafeInteger(i.paid)||i.paid<0||i.paid>i.amount)throw Error('Invalid invoice relationship or centavos');}
 const references=new Set();
 for(const p of source.payments){const i=invoices.get(p.invoice_id);if(!i||i.member_id!==p.member_id||!Number.isSafeInteger(p.amount)||p.amount<=0)throw Error('Invalid payment relationship or centavos');if(p.reference_key){if(references.has(p.reference_key))throw Error('Duplicate payment reference');references.add(p.reference_key);}}
 for(const i of source.invoices){const paid=source.payments.filter(p=>p.invoice_id===i.id).reduce((n,p)=>n+p.amount,0);if(paid!==i.paid)throw Error('Invoice paid total differs from payment ledger');}
 for(const s of source.submissions){const i=invoices.get(s.invoice_id);if(!i||i.member_id!==s.member_id)throw Error('Orphan payment submission');}
 for(const c of source.checkins)if(!members.has(c.member_id))throw Error('Orphan check-in');
 return {counts:Object.fromEntries(tables.map(t=>[t,source[t].length])),invoiceCents:source.invoices.reduce((n,i)=>n+i.amount,0),paidCents:source.payments.reduce((n,p)=>n+p.amount,0),requiresAccountInvitations:source.members.length>0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.argv[2])throw Error('Usage: node scripts/validate-d1-export.js .local/d1-export.json');
 const raw=await readFile(process.argv[2],'utf8');const summary=validateExport(JSON.parse(raw));
 await mkdir('.local',{recursive:true});await writeFile('.local/d1-validation.json',JSON.stringify({...summary,sha256:createHash('sha256').update(raw).digest('hex'),validatedAt:new Date().toISOString()},null,2));
 console.log(JSON.stringify(summary));
}
