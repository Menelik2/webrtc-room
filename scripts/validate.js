#!/usr/bin/env node
/** Basic presence check for CI / Vercel build */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const required = [
  'client/index.html',
  'client/style.css',
  'client/app.js',
  'server/server.js',
  'server/package.json',
];

let ok = true;
for (const f of required) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    console.error('missing:', f);
    ok = false;
  }
}

if (!ok) process.exit(1);
console.log('validate: all required files present');
