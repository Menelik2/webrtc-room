#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const appJs = path.join(__dirname, '..', 'client', 'app.js');
if (!fs.existsSync(appJs)) {
  console.error('client/app.js missing');
  process.exit(1);
}
execSync(`node --check "${appJs}"`, { stdio: 'inherit' });
console.log('client/app.js OK');
