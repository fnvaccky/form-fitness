import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handle } from './api.js';
const root=path.resolve('public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
function appOrigin(env){try{return new URL(env.APP_ORIGIN);}catch{return null;}}
export function createDevServer(env=process.env){
  const target=appOrigin(env);
  return http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname.startsWith('/api/'))return handle(req,res,env);
    // Local only: a page opened on another host (127.0.0.1 vs localhost, another port) would send the
    // wrong Origin and fail the API's strict check, so send the browser to APP_ORIGIN first.
    if(target&&['GET','HEAD'].includes(req.method)&&(req.headers.host||'').toLowerCase()!==target.host.toLowerCase()){
      res.statusCode=302;res.setHeader('Location',target.origin+req.url);return res.end();
    }
    try {
      const file=path.resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(root+path.sep))throw Error('Invalid path');
      res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
      res.end(await readFile(file));
    }catch{res.statusCode=404;res.end('Not found');}
  });
}
export function startupMessages(env,port){
  const target=appOrigin(env);
  if(!target)return ['APP_ORIGIN is not set. Copy it from .env.example into .env.local, for example APP_ORIGIN=http://localhost:4173.'];
  const lines=[`Open ${target.origin}`];
  const originPort=Number(target.port||(target.protocol==='https:'?443:80));
  if(originPort!==port)lines.push(`Warning: the server listens on port ${port} but APP_ORIGIN uses port ${originPort}. Pages will redirect to ${target.origin}, and forms only work there. Make PORT and APP_ORIGIN match.`);
  return lines;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  const port=Number(process.env.PORT||4173);
  createDevServer().listen(port,'127.0.0.1',()=>{
    console.log(`RepReady development server listening on port ${port}`);
    for(const line of startupMessages(process.env,port))(line.startsWith('Warning')?console.warn:console.log)(line);
  });
}
