'use strict';
// Supabase falls back to the Site URL (any host, root path) when an email link's redirect isn't
// allowed. A link that carries token_hash on any path goes straight to the server callback, which
// moves it to APP_ORIGIN and verifies it there, before the sign-in page renders. The token is
// stripped from the current history entry, and location.replace keeps it out of history.
const authLinkForwarded=(()=>{
 const query=new URLSearchParams(location.search);
 if(!query.get('token_hash')||!['recovery','invite','signup','email'].includes(query.get('type')||''))return false;
 if(location.pathname==='/api/auth/callback')return false;
 const target='/api/auth/callback'+location.search;
 history.replaceState(null,'',location.pathname+location.hash);
 location.replace(target);
 return true;
})();
