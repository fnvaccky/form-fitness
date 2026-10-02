import {fail} from './validation.js';
export const PAYMONGO_METHODS=Object.freeze({gcash:'GCash',paymaya:'Maya',grab_pay:'GrabPay',card:'Card'});
export function paymongoConfiguration(env=process.env){
 const requested=String(env.PAYMONGO_METHODS??'gcash,paymaya,grab_pay,card').split(',').map(x=>x.trim()).filter(Boolean);
 const methods=[...new Set(requested.filter(x=>Object.hasOwn(PAYMONGO_METHODS,x)))];
 let disabledReason='';
 if(String(env.PAYMONGO_ALLOW_LIVE??'false')!=='false')disabledReason='live_mode_forbidden';
 else if(String(env.PAYMONGO_SECRET_KEY||'').startsWith('sk_live_'))disabledReason='live_key_forbidden';
 else if(!/^sk_test_[A-Za-z0-9_-]+$/.test(env.PAYMONGO_SECRET_KEY||''))disabledReason='test_key_missing';
 else if(!env.PAYMONGO_WEBHOOK_SECRET)disabledReason='webhook_secret_missing';
 else if(!methods.length)disabledReason='invalid_methods';
 return {configured:!disabledReason,methods,testMode:true,disabledReason};
}
export function requirePaymongoTestMode(env=process.env){
 const config=paymongoConfiguration(env);
 if(!config.configured)fail(['live_mode_forbidden','live_key_forbidden'].includes(config.disabledReason)?'PayMongo is restricted to test mode. Live payments are disabled.':'PayMongo test checkout is not configured. Contact the gym or use a manual payment.',503);
 return config;
}
