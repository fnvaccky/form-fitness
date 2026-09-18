import { connect } from 'cloudflare:sockets';

// Gmail submission over implicit TLS. Credentials are never included in errors.
export async function gmailSMTP(settings, message = null) {
  const socket = connect({ hostname: 'smtp.gmail.com', port: 465 }, { secureTransport: 'on' });
  const reader = socket.readable.getReader(), writer = socket.writable.getWriter();
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  let buffer = '', accepted = false;
  const timer = setTimeout(() => socket.close().catch(() => {}), 18000);
  async function response(expected) {
    while (true) {
      const lines = buffer.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const code = Number(lines[i].slice(0, 3));
          buffer = lines.slice(i + 1).join('\r\n');
          if (!expected.includes(code)) throw new Error(code === 535 ? 'Gmail rejected the app password. Check the sender address and Google app password.' : `Gmail SMTP returned ${code}.`);
          return;
        }
      }
      const next = await reader.read();
      if (next.done) throw new Error('Gmail closed the connection before confirming delivery.');
      buffer += decoder.decode(next.value, { stream: true });
      if (buffer.length > 64000) throw new Error('Unexpected Gmail response.');
    }
  }
  async function command(text, expected) { await writer.write(encoder.encode(text + '\r\n')); await response(expected); }
  try {
    await socket.opened;
    await response([220]);
    await command('EHLO form-fitness.chatgpt.site', [250]);
    await command('AUTH LOGIN', [334]);
    await command(btoa(settings.address), [334]);
    await command(btoa(settings.password), [235]);
    if (!message) { await command('QUIT', [221]); return; }
    await command(`MAIL FROM:<${settings.address}>`, [250]);
    await command(`RCPT TO:<${message.recipient}>`, [250, 251]);
    await command('DATA', [354]);
    const encodedBody = btoa(String.fromCharCode(...encoder.encode(message.body))).match(/.{1,76}/g).join('\r\n');
    const encodedSubject = btoa(String.fromCharCode(...encoder.encode(message.subject)));
    const text = [`From: FORM Fitness <${settings.address}>`, `To: <${message.recipient}>`, `Subject: =?UTF-8?B?${encodedSubject}?=`, `Message-ID: <${message.id}@form-fitness.chatgpt.site>`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedBody, '.'].join('\r\n');
    await command(text, [250]); accepted = true;
    await command('QUIT', [221]).catch(() => {});
  } finally {
    clearTimeout(timer); reader.releaseLock(); writer.releaseLock(); await socket.close().catch(() => {});
  }
  return { accepted };
}
