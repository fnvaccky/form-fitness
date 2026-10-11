'use strict';
// Email links carry a one-time token. Link scanners in mail services and browsers open them before
// people do, so nothing a plain visit runs may use it up (BUG-011): only Save password checks it.
const AUTH_LINK_TYPES=['recovery','invite','signup','email'];
// Supabase falls back to the Site URL (any host, root path) when an email link's redirect isn't
// allowed. A link that carries token_hash on any path goes straight to the server callback, which
// moves it to APP_ORIGIN and on to the set-password screen, before the sign-in page renders. The token
// is stripped from the current history entry, and location.replace keeps it out of history.
const authLinkForwarded=(()=>{
 const query=new URLSearchParams(location.search);
 if(!query.get('token_hash')||!AUTH_LINK_TYPES.includes(query.get('type')||''))return false;
 if(location.pathname==='/api/auth/callback')return false;
 const target='/api/auth/callback'+location.search;
 history.replaceState(null,'',location.pathname+location.hash);
 location.replace(target);
 return true;
})();
// The callback hands the token over in the fragment (/#/set-password?token_hash=…&type=…), which browsers
// never send to a server or put in a referrer. It is read here once, before anything else runs, kept in
// memory only, and removed from the address bar and the current history entry.
let setupLink=(()=>{
 const hash=location.hash,at=hash.indexOf('?');
 if(authLinkForwarded||at<0||hash.slice(0,at)!=='#/set-password')return null;
 history.replaceState(null,'',location.pathname+'#/set-password');
 const query=new URLSearchParams(hash.slice(at+1)),tokenHash=query.get('token_hash')||'',type=query.get('type')||'';
 return tokenHash&&AUTH_LINK_TYPES.includes(type)?{tokenHash,type}:null;
})();
