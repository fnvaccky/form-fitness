import {mkdir,writeFile} from 'node:fs/promises';
import {vercelRequest,verifiedVercelUser,TEAM} from './vercel-client.js';
await verifiedVercelUser();
let project;
try{project=await vercelRequest('/v9/projects/form-fitness');}catch(error){if(error.status!==404)throw error;}
if(!project){project=await vercelRequest('/v11/projects','POST',{name:'form-fitness',framework:null,buildCommand:'npm run build',installCommand:'npm ci --omit=dev',outputDirectory:'dist/client',publicSource:false,ssoProtection:{deploymentType:'all'}});}
if(project.accountId!==TEAM)throw Error('Vercel project belongs to another team.');
if(project.ssoProtection?.deploymentType!=='all'){
 await vercelRequest('/v9/projects/'+project.id,'PATCH',{ssoProtection:{deploymentType:'all'}});
 project=await vercelRequest('/v9/projects/'+project.id);
}
if(project.ssoProtection?.deploymentType!=='all')throw Error('STOP: all-deployment protection is not enabled.');
await mkdir('.vercel',{recursive:true});await mkdir('.local',{recursive:true});
await writeFile('.vercel/project.json',JSON.stringify({projectId:project.id,orgId:TEAM,projectName:project.name},null,2));
await writeFile('.local/vercel-protection.json',JSON.stringify({projectId:project.id,teamId:TEAM,protection:project.ssoProtection,verifiedAt:new Date().toISOString(),productionDeployment:false},null,2));
console.log(JSON.stringify({projectId:project.id,name:project.name,teamId:TEAM,protection:project.ssoProtection}));
