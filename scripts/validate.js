#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = false;

function check(file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error('MISSING:', file);
    failed = true;
    return;
  }
  console.log('OK exists:', file);
}

check('server/server.js');
check('server/package.json');
check('client/index.html');
check('client/style.css');
check('client/app.js');
check('package.json');
check('README.md');

try {
  execSync('node --check server/server.js', { cwd: root, stdio: 'pipe' });
  console.log('OK syntax: server/server.js');
} catch (e) {
  console.error('SYNTAX FAIL: server/server.js');
  failed = true;
}

try {
  // app.js is browser JS — basic parse via Function is fragile; just size check
  const app = fs.readFileSync(path.join(root, 'client/app.js'), 'utf8');
  if (app.length < 500) {
    console.error('client/app.js looks empty');
    failed = true;
  } else {
    console.log('OK size: client/app.js');
  }
} catch (e) {
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log('\nValidation passed.');
