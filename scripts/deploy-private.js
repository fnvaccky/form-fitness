import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {vercelRequest,verifiedVercelUser,TEAM} from './vercel-client.js';
await verifiedVercelUser();
const link=JSON.parse(await readFile('.vercel/project.json','utf8'));
if(link.orgId!==TEAM)throw Error('Wrong Vercel team.');
const project=await vercelRequest('/v9/projects/'+link.projectId);
if(project.ssoProtection?.deploymentType!=='all')throw Error('STOP: all-deployment protection is not enabled.');
if(process.env.APP_WORKSPACE!=='demo')throw Error('This delivery command only deploys the isolated demo. Review production cutover separately.');
if(process.env.SUPABASE_URL!=='https://ivxbrhqqfgmhfpgpauzh.supabase.co')throw Error('Wrong Supabase project.');
const environment=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','APP_WORKSPACE'];
for(const key of environment){if(!process.env[key])throw Error('Missing '+key);await vercelRequest(`/v10/projects/${project.id}/env?upsert=true`,'POST',{key,value:process.env[key],type:'encrypted',target:['preview']});}
// No APP_ORIGIN override: the function uses this deployment's exact VERCEL_URL.
// Elevated credentials and Gmail are deliberately absent from the demo deployment.
const files=[];
async function add(file){files.push({file,data:(await readFile(file)).toString('base64'),encoding:'base64'});}
async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=dir+'/'+item.name;if(item.isDirectory())await walk(file);else await add(file);}}
for(const dir of ['api','src','public'])await walk(dir);
for(const file of ['package.json','package-lock.json','build.cjs','vercel.json'])await add(file);
const deployment=await vercelRequest('/v13/deployments','POST',{name:project.name,project:project.id,target:'staging',files,projectSettings:{framework:null,buildCommand:'npm run build',installCommand:'npm ci --omit=dev',outputDirectory:'dist/client',nodeVersion:'24.x'},meta:{purpose:'private-form-fitness-demo'}});
await mkdir('.local',{recursive:true});
await writeFile('.local/deployment.json',JSON.stringify({id:deployment.id,url:'https://'+deployment.url,projectId:project.id,teamId:TEAM,target:deployment.target||'preview'},null,2));
if(deployment.target==='production')throw Error('Unexpected production target; all-deployment protection is active. Review before continuing.');
console.log(JSON.stringify({id:deployment.id,url:'https://'+deployment.url,status:deployment.readyState||deployment.status,target:deployment.target||'preview'}));
