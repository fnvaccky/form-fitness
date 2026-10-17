import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {emailLayout} from '../src/email-layout.js';

// Authored Go template fragments are kept as Go expressions so Supabase's html/template
// performs contextual escaping. Never substitute member data or real tokens at build time.
const greeting = '<p style="margin:0 0 18px;">{{ if .Data.name }}Hello {{ .Data.name }},{{ else }}Hello,{{ end }}</p>';
const account = '<p style="margin:0 0 18px;">Login email: <strong>{{ .Email }}</strong></p>';
const purchase = '{{ if .Data.plan_name }}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;background-color:#f5f6f2;border:1px solid #e6e9e2;border-radius:6px;"><tr><td style="padding:18px;font-size:14px;line-height:23px;"><p style="margin:0 0 10px;"><strong>Your purchased membership</strong></p><p style="margin:0 0 12px;">Plan: {{ .Data.plan_name }}<br>Membership dates: {{ .Data.start }} to {{ .Data.membership_end }}</p><p style="margin:0 0 6px;"><strong>Your plan privileges</strong></p><ul style="margin:0;padding-left:20px;">{{ range .Data.plan_features }}<li style="margin:0 0 5px;">{{ . }}</li>{{ end }}</ul></td></tr></table>{{ end }}';
const access = '<p style="margin:0 0 18px;font-size:14px;line-height:23px;">{{ if .Data.plan_name }}Your membership and member pass are available only after confirmed full payment and while your membership dates and account are valid.{{ else }}After choosing your password, sign in with this email address. Your gym administrator manages your access.{{ end }}</p>';
export function authEmailTemplates() {
  return {
    'invite.html':emailLayout({title:'Set up your password',preheader:'Your RepReady account is ready. Choose your password to get started.',
      bodyHtml:greeting+'<p style="margin:0 0 18px;">Your RepReady account is ready. Set up your password to sign in.</p>'+account,detailsHtml:purchase+access,
      action:{label:'Set up your password',url:'{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite'},
      footer:'Never share your setup link or password. If this link expires, request a new link from the RepReady sign-in page. Need help? Contact gym reception.'}),
    'recovery.html':emailLayout({title:'Choose your RepReady password',preheader:'Use this secure link to choose your RepReady password.',
      bodyHtml:greeting+'<p style="margin:0 0 18px;">Use the button below to choose a password for your RepReady account.</p>'+account,detailsHtml:purchase+access+'<p style="margin:0 0 18px;font-size:14px;line-height:23px;">If you did not request this email or arrange account setup with the gym, you can ignore it. Your password stays unchanged until you choose a new one.</p>',
      action:{label:'Choose password',url:'{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery'},
      footer:'Never share this link or your password. If this link expires, request a new link from the RepReady sign-in page. Need help? Contact gym reception.'})
  };
}
// Companions for review/custom-delivery integration. Supabase's existing SMTP template setting
// accepts HTML only; these files are not falsely advertised as an active MIME alternative.
export function authTextTemplates() {
  const details='{{ if .Data.plan_name }}\nYour purchased membership\nPlan: {{ .Data.plan_name }}\nMembership dates: {{ .Data.start }} to {{ .Data.membership_end }}\nYour plan privileges:\n{{ range .Data.plan_features }}- {{ . }}\n{{ end }}{{ end }}';
  const hello='{{ if .Data.name }}Hello {{ .Data.name }},{{ else }}Hello,{{ end }}\n\n';
  const accessText='{{ if .Data.plan_name }}Your membership and member pass are available only after confirmed full payment and while your membership dates and account are valid.{{ else }}After choosing your password, sign in with this email address. Your gym administrator manages your access.{{ end }}';
  return {
    'invite.txt':'RepReady\nGYM MEMBERSHIP\n\nSet up your password\n\n'+hello+'Your RepReady account is ready. Set up your password to sign in.\n\nLogin email: {{ .Email }}\n'+details+'\n'+accessText+'\n\nSet up your password:\n{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite\n\nNever share your setup link or password. If this link expires, request a new link from the RepReady sign-in page. Need help? Contact gym reception.\n',
    'recovery.txt':'RepReady\nGYM MEMBERSHIP\n\nChoose your RepReady password\n\n'+hello+'Use this secure link to choose a password for your RepReady account.\n\nLogin email: {{ .Email }}\n'+details+'\n'+accessText+'\n\nChoose password:\n{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery\n\nIf you did not request this email or arrange account setup with the gym, you can ignore it. Your password stays unchanged until you choose a new one.\n\nNever share this link or your password. If this link expires, request a new link from the RepReady sign-in page. Need help? Contact gym reception.\n'
  };
}
export async function buildEmailTemplates({check=false}={}) {
  for(const [name,html] of Object.entries({...authEmailTemplates(),...authTextTemplates()})) {
    const file=new URL('../supabase/templates/'+name,import.meta.url);
    if(check){if((await readFile(file,'utf8')).replace(/\r\n/g,'\n')!==html)throw Error('Email template source differs from its generated file: '+name);}
    else await writeFile(file,html);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await buildEmailTemplates({check:process.argv.includes('--check')});console.log('PASS: email templates '+(process.argv.includes('--check')?'match their shared source.':'generated.'));}
