import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handle } from './api.js';
const root=path.resolve('public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const port=Number(process.env.PORT||4173);
http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname.startsWith('/api/'))return handle(req,res);
  try {
    const file=path.resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep))throw Error('Invalid path');
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    res.end(await readFile(file));
  }catch{res.statusCode=404;res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`FORM Fitness development server: http://localhost:${port}`));
