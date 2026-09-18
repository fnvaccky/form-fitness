const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, 'dist');
if (path.dirname(output) !== path.resolve(__dirname) || path.basename(output) !== 'dist') throw Error('Unsafe build output');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive:true });
fs.cpSync(path.join(__dirname, 'public'), path.join(output,'client'), { recursive: true });
console.log('Static assets built in dist/client. Vercel builds api/index.js as a Node function.');
