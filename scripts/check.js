import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for(const dir of ['src','api','scripts','public'])for(const name of readdirSync(dir)) {
  if(!name.endsWith('.js'))continue;
  const result=spawnSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});
  if(result.status)process.exit(result.status);
}
console.log('PASS: JavaScript syntax checks.');
