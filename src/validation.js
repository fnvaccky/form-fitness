export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (message, status = 400) => { throw new HttpError(status, message); };
export const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export function contacts(body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  let phone = String(body.phone || '').replace(/[\s()-]/g, '');
  if (name.length < 2 || name.length > 70 || /[<>\r\n]/.test(name)) fail('Enter a full name between 2 and 70 characters.');
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || email.length > 100) fail('Enter a valid email address.');
  if (!/^(09\d{9}|\+639\d{9})$/.test(phone)) fail('Mobile number is required. Use 09XXXXXXXXX or +639XXXXXXXXX.');
  if (phone.startsWith('+63')) phone = '0' + phone.slice(3);
  return { name, email, phone };
}
export function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || !/[a-z]/i.test(value) || !/\d/.test(value)) fail('Use 12–128 characters with a letter and a number.');
  return value;
}
export function startDate(value, current = today()) {
  const last = new Date(current + 'T12:00:00Z'); last.setUTCDate(last.getUTCDate() + 365);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value < current || value > last.toISOString().slice(0, 10)) fail('Choose a valid start date within the next year.');
  return value;
}
// Parse decimal digits, never multiply a floating-point accounting value.
export function cents(value) {
  const text = String(value);
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) fail('Enter a positive amount with at most two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result < 1 || result > 10000000) fail('Amount must be between PHP 0.01 and PHP 100,000.');
  return result;
}
export function imageData(value) {
  if (typeof value !== 'string' || value.length > 900000) fail('Choose an image under 650 KB.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(value);
  if (!match) fail('Choose a PNG, JPEG, or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  if (!valid || bytes.length > 650000) fail('The image is invalid or larger than 650 KB.');
  return { bytes, contentType: `image/${match[1]}`, extension: match[1] };
}
