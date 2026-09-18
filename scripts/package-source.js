import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
const out=path.resolve('artifacts/form-fitness-source.zip');
await mkdir('artifacts',{recursive:true});
const files=[];
const roots=['api','src','public','scripts','tests','supabase/migrations','legacy'];
async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=dir+'/'+item.name;if(item.isDirectory())await walk(file);else files.push(file);}}
for(const root of roots)await walk(root);
files.push('package.json','package-lock.json','build.cjs','vercel.json','.vercelignore','.gitignore','.env.example','README.md','DEPLOYMENT.md','DEMO_ACCOUNTS.md','MIGRATION_NOTES.md','TEST_RESULTS.md','CODEX_VERCEL_SUPABASE_PROMPT.md');
for(const file of files){
  if(/(^|\/)(\.env(?!\.example)|\.local|node_modules|dist|test-results|\.git|\.vercel)(\/|$)/.test(file))throw Error('Unsafe archive entry.');
  if(/\.(js|cjs|json|sql|md)$/.test(file)){const text=await readFile(file,'utf8');if(/sb_secret_[A-Za-z0-9_-]{15,}|sbp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text))throw Error('Possible secret in '+file);}
}
await mkdir('.local',{recursive:true});await writeFile('.local/source-manifest.json',JSON.stringify([...new Set(files)].sort()));
const output=createWriteStream(out);const archive=new ZipArchive({zlib:{level:9}});
const finished=new Promise((resolve,reject)=>{output.on('close',resolve);archive.on('error',reject);output.on('error',reject);});
archive.pipe(output);for(const file of [...new Set(files)].sort())archive.file(file,{name:'form-fitness/'+file});
await archive.finalize();await finished;
console.log(`Source ZIP created: ${out} (${files.length} source files; no secrets, private data, dependencies, or build caches).`);
