'use strict';
// Same-origin invalidations only. The server session, never a message, supplies account identity.
(()=>{
 if(window.repreadySessionSyncInstalled)return;
 window.repreadySessionSyncInstalled=true;
 const CHANNEL='repready-session-v1',KEY='repready.session.changed.v1';
 const reasons=new Set(['login','logout','password','expired','login-failed','logout-failed','setup','account']);
 const seen=new Set();
 let channel=null,paused=false,timer=null,inFlight=null,sequence=0,waiting=false;
 const identity=authenticatedOwner;
 function notice(message,retry=false){
  document.getElementById('app').innerHTML=`<div class="loading-screen" role="status"><span class="brandmark">R</span><h2>Checking your session</h2><p>${esc(message)}</p>${retry?btn('Check session','sync-session','primary'):''}</div>`;
 }
 function clearPrivate(retry=true){beginAuthChange('tab');authReady=true;notice('Your sign-in changed in another tab. Confirming the current server session…',retry);}
 function connect(){
  if(channel||typeof BroadcastChannel!=='function')return;
  try{channel=new BroadcastChannel(CHANNEL);channel.onmessage=event=>receive(event.data);}catch{channel=null;}
 }
 function publish(phase,reason){
  const message={v:1,id:crypto.randomUUID(),phase,reason};
  if(channel){try{channel.postMessage(message);return;}catch{}}
  try{localStorage.setItem(KEY,JSON.stringify(message));}catch{/* Focus/return revalidation also works when storage is unavailable. */}
 }
 async function revalidate({clear=true}={}){
  if(inFlight)return inFlight.promise;
  const task={sequence:++sequence,promise:null};
  if(clear)clearPrivate(false);
  const epoch=authEpoch,previous=currentUser,previousDate=DEMO_DATE;
  task.promise=(async()=>{
   try{
    const session=await api('/session');
    if(epoch!==authEpoch||task.sequence!==sequence)return;
    document.getElementById('session-sync-error')?.remove();
    const changed=identity(previous)!==identity(session.user);
    if(!clear&&!changed&&JSON.stringify(previous)===JSON.stringify(session.user)&&previousDate===session.date
     &&(previous||document.getElementById('login-form')))return;
    if(changed&&!clear)clearPrivate();
    currentUser=session.user;DEMO_DATE=session.date;authReady=true;
    if(currentUser){
     mode=portalViewMode(mode);await refreshData();
     if(task.sequence!==sequence)return;
     if(/^#\/(member|admin)(?:\/|$)/.test(location.hash))route();
     document.dispatchEvent(new Event('repready-ready'));
    }else render();
   }catch(error){
    if(isStaleResponse(error)||task.sequence!==sequence)return;
    if(!clear&&previous&&epoch===authEpoch){
     // A failed background check is not an account change. Keep this owner's drafts;
     // an invalidation or an actual 401 still clears them immediately through the epoch guard.
     document.getElementById('session-sync-error')?.remove();
     document.getElementById('app').insertAdjacentHTML('afterbegin',`<div class="notice" id="session-sync-error" role="alert">Your session could not be rechecked. Check your connection. ${btn('Retry session check','sync-session','small')}</div>`);
     return;
    }
    beginAuthChange('session-error');authReady=true;
    notice('Your session could not be confirmed. Your previous account is hidden. Check your connection and try again.',true);
   }
  })().finally(()=>{if(inFlight===task)inFlight=null;});
  inFlight=task;return task.promise;
 }
 window.revalidateRepReadySession=revalidate;
 function schedule(clear=false){
  if(paused)return;
  if(clear)clearPrivate();
  clearTimeout(timer);
  timer=setTimeout(()=>{timer=null;revalidate({clear:false});},50);
 }
 function receive(message){
  if(paused||!message||message.v!==1||!['begin','committed'].includes(message.phase)||!reasons.has(message.reason)
   ||typeof message.id!=='string'||!/^[0-9a-f-]{36}$/i.test(message.id)||Object.keys(message).some(key=>!['v','id','phase','reason'].includes(key))||seen.has(message.id))return;
  seen.add(message.id);if(seen.size>100)seen.delete(seen.values().next().value);
  clearTimeout(timer);timer=null;sequence++;inFlight=null;
  if(message.phase==='begin'){
   waiting=true;clearPrivate();
   // Stay private until the sending action finishes; a closed sender can be recovered explicitly.
   return;
  }
  waiting=false;schedule(true);
 }
 document.addEventListener('repready-auth-changing',event=>{
  if(!['login','logout'].includes(event.detail?.reason))return;
  clearTimeout(timer);timer=null;sequence++;inFlight=null;waiting=true;
  publish('begin',event.detail.reason);
 });
 document.addEventListener('repready-auth-committed',event=>{
  const reason=event.detail?.reason;if(reasons.has(reason)){waiting=false;publish('committed',reason);}
 });
 window.addEventListener('storage',event=>{
  if(event.key!==KEY||!event.newValue)return;
  try{receive(JSON.parse(event.newValue));}catch{}
 });
 document.addEventListener('click',event=>{
  if(!event.target.closest('[data-action="sync-session"]'))return;
  event.preventDefault();event.stopImmediatePropagation();if(inFlight)return;waiting=false;
  clearTimeout(timer);timer=null;revalidate({clear:!currentUser});
 },true);
 const onReturn=()=>{if(authReady&&!paused&&!waiting&&!stateRefresh)schedule();};
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)onReturn();});
 window.addEventListener('focus',onReturn);
 window.addEventListener('pagehide',()=>{
  paused=true;clearTimeout(timer);timer=null;sequence++;inFlight=null;
  channel?.close();channel=null;beginAuthChange('pagehide');
 });
 window.addEventListener('pageshow',event=>{
  paused=false;connect();if(event.persisted){waiting=false;schedule(true);}
 });
 connect();
})();
