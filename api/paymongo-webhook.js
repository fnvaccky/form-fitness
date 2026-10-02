import {handle} from '../src/api.js';
import {Readable} from 'node:stream';
// A Web Handler reads the original request stream; JSON body helpers cannot change signed bytes.
export async function POST(request){
 const req=request.body?Readable.fromWeb(request.body):Readable.from([]);
 req.method=request.method;req.url='/api/paymongo/webhook';req.headers=Object.fromEntries(request.headers);
 const headers=new Headers();let output='';
 const res={statusCode:200,setHeader:(name,value)=>headers.set(name,value),end:value=>{output=value||'';}};
 await handle(req,res);
 return new Response(output,{status:res.statusCode,headers});
}
