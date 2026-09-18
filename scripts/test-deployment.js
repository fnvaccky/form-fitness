import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {vercelRequest,verifiedVercelUser} from './vercel-client.js';
await verifiedVercelUser();
const deployment=JSON.parse(await readFile('.local/deployment.json','utf8'));
const current=await vercelRequest('/v13/deployments/'+deployment.id);
const project=await vercelRequest('/v9/projects/'+deployment.projectId);
if(current.readyState!=='READY')throw Error('Wait for deployment READY before testing.');
if(project.ssoProtection?.deploymentType!=='all')throw Error('All-deployment protection must be enabled.');
const response=await fetch(deployment.url,{redirect:'manual'});
if(!(response.status===401||response.status===403||(response.status>=300&&response.status<400&&/vercel\.com/.test(response.headers.get('location')||''))))throw Error('Anonymous visitor was not blocked.');
const secret=randomBytes(16).toString('hex');
await vercelRequest(`/v1/projects/${deployment.projectId}/protection-bypass`,'PATCH',{generate:{secret,note:'Temporary FORM migration verification; revoked by test runner'}});
await writeFile('.local/temporary-verification.json',JSON.stringify({projectId:deployment.projectId,secret}),{mode:0o600});
const env={...process.env,TEST_BASE_URL:deployment.url,APP_WORKSPACE:'demo',VERCEL_AUTOMATION_BYPASS_SECRET:secret};
async function run(file){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[file],{stdio:'inherit',env});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(file+' failed')));});}
try{
 for(let attempt=0;attempt<90;attempt++){
  const checks=await Promise.all(['/api/session','/app.js','/connected.js','/styles.css'].map(async asset=>{
   const r=await fetch(deployment.url+asset,{headers:{'x-vercel-protection-bypass':secret},redirect:'manual'});
   const type=r.headers.get('content-type')||'';
   return r.ok && (asset.endsWith('.js')?type.includes('javascript'):asset.endsWith('.css')?type.includes('css'):type.includes('json'));
  }));
  if(checks.every(Boolean))break;
  if(attempt%15===0)console.log('Waiting for temporary verification access on API and static assets.');
  if(attempt===89)throw Error('Verification access did not propagate to all deployment routes.');
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 if(!process.argv.includes('--browser-only'))await run('tests/integration.js');await run('tests/browser.js');
}
finally{
 await vercelRequest(`/v1/projects/${deployment.projectId}/protection-bypass`,'PATCH',{revoke:{secret,regenerate:false}});
 await writeFile('.local/temporary-verification.json',JSON.stringify({revoked:true,projectId:deployment.projectId}));
 console.log('Temporary verification access revoked. Deployment protection remained enabled.');
}
