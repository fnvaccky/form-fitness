// Shared, image-independent transactional email shell. bodyHtml/detailsHtml are authored markup;
// callers must escape every dynamic value before inserting it there. No tracking or remote assets.
export const escapeEmail = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function emailLayout({title,preheader='',bodyHtml,detailsHtml='',action,footer='Need help? Contact gym reception. Please do not reply with your password or private account details.'}) {
  const button = action ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 24px;"><tr><td bgcolor="#1e5744" style="border-radius:6px;text-align:center;"><a href="${escapeEmail(action.url)}" style="display:inline-block;padding:15px 24px;border:1px solid #1e5744;border-radius:6px;color:#ffffff;background-color:#1e5744;text-decoration:none;font-size:16px;line-height:22px;font-weight:bold;mso-padding-alt:0;">${escapeEmail(action.label)}</a></td></tr></table><p style="margin:0 0 8px;font-size:13px;line-height:21px;color:#59685f;">If the button does not work, copy and paste this link into your browser:</p><p style="margin:0 0 24px;font-size:13px;line-height:21px;word-break:break-all;overflow-wrap:anywhere;"><a href="${escapeEmail(action.url)}" style="color:#1e5744;text-decoration:underline;word-break:break-all;overflow-wrap:anywhere;">${escapeEmail(action.url)}</a></p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeEmail(title)}</title>
<style>@media only screen and (max-width:600px){.email-outer{padding:16px 10px!important}.email-content{padding:26px 20px!important}.email-header{padding:24px 20px!important}.email-heading{font-size:26px!important;line-height:34px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f5f6f2;color:#263b34;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeEmail(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f5f6f2"><tr><td class="email-outer" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;table-layout:fixed;background-color:#ffffff;border:1px solid #e6e9e2;border-radius:12px;overflow:hidden;">
<tr><td class="email-header" bgcolor="#183e33" style="padding:28px 32px;color:#ffffff;"><p style="margin:0;font-size:25px;line-height:32px;font-weight:bold;letter-spacing:-0.5px;color:#ffffff;">RepReady</p><p style="margin:5px 0 0;font-size:11px;line-height:17px;letter-spacing:1.5px;color:#dcf0c6;">GYM MEMBERSHIP</p></td></tr>
<tr><td class="email-content" style="padding:32px;font-size:16px;line-height:26px;word-wrap:break-word;overflow-wrap:anywhere;">
<h1 class="email-heading" style="margin:0 0 22px;color:#183e33;font-size:28px;line-height:36px;font-weight:bold;">${escapeEmail(title)}</h1>
${bodyHtml}
${button}
${detailsHtml}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #e6e9e2;"><tr><td style="padding-top:20px;"><p style="margin:0;color:#59685f;font-size:13px;line-height:21px;">${escapeEmail(footer)}</p></td></tr></table>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
<p style="margin:20px 0 0;color:#59685f;font-size:12px;line-height:20px;">RepReady · Your gym. Your progress.</p>
</td></tr></table></body></html>
`;
}

export function textParagraphs(text) {
  return String(text).split(/\r?\n\s*\r?\n/).map(paragraph => `<p style="margin:0 0 18px;">${escapeEmail(paragraph).replace(/\r?\n/g,'<br>')}</p>`).join('\n');
}

export function notificationEmail({subject,text,action}) {
  if(action){const url=new URL(action.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Email action destination is invalid.');}
  // The plain-text alternative stays intact. These two existing navigation lines become
  // one prominent payment action plus the fallback link in HTML, without changing destinations.
  const body = action ? text.split('\n').filter(line=>!line.startsWith('View your member pass: ')&&!line.startsWith('View invoices and payment instructions: ')).join('\n') : text;
  return {text,html:emailLayout({title:subject,preheader:'An update from your RepReady gym.',bodyHtml:textParagraphs(body),action})};
}
