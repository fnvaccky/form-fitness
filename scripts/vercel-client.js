import {readFile} from 'node:fs/promises';
import path from 'node:path';
export const TEAM='team_E73K426NyjwlO1fFqAckGqki';
export const USER='tEwA3fweki16jBIGSdgE8dW3';
export async function vercelRequest(endpoint,method='GET',body){
 let token=process.env.VERCEL_TOKEN;
 if(!token&&process.env.APPDATA){try{token=JSON.parse(await readFile(path.join(process.env.APPDATA,'com.vercel.cli','Data','auth.json'),'utf8')).token;}catch{}}
 if(!token)throw Error('Sign in to NACKY with the Vercel CLI, or supply VERCEL_TOKEN securely.');
 const response=await fetch('https://api.vercel.com'+endpoint+(endpoint.includes('?')?'&':'?')+'teamId='+TEAM,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();
 if(!response.ok){const error=Error(`Vercel API ${response.status}: ${data.error?.code||'request_failed'}`);error.status=response.status;error.details=data.error?.message;throw error;}
 return data;
}
export async function verifiedVercelUser(){
 const {user}=await vercelRequest('/v2/user');
 if(user.id!==USER||user.email!=='achillespasuncion@gmail.com')throw Error('Authenticated Vercel account is not the verified NACKY account.');
 return user;
}
