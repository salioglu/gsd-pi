#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.prepack-backup');

const {
  INTERNAL_PACKAGE_NAMES,
  RELEASE_WORKSPACE_PACKAGE_DIRS,
} = require('./lib/version-sync.cjs');

const TARGET_PACKAGE_JSONS = [
  path.join(ROOT, 'package.json'),
  ...RELEASE_WORKSPACE_PACKAGE_DIRS.map((dir) => path.join(ROOT, dir, 'package.json')),
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function usesWorkspaceProtocol(pkg) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const [dep, range] of Object.entries(pkg[field])) {
      if (!INTERNAL_PACKAGE_NAMES.has(dep)) continue;
      if (range === 'workspace:*' || range === '*') return true;
    }
  }
  return false;
}

function resolvePackageJson(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const pkg = readJson(filePath);
  if (!usesWorkspaceProtocol(pkg)) return false;

  const version = pkg.version;
  const relPath = path.relative(ROOT, filePath);
  const backupPath = path.join(BACKUP_DIR, relPath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);

  let changed = false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const [dep, range] of Object.entries(pkg[field])) {
      if (!INTERNAL_PACKAGE_NAMES.has(dep)) continue;
      if (range !== 'workspace:*' && range !== '*') continue;
      const resolved = `^${version}`;
      if (pkg[field][dep] !== resolved) {
        pkg[field][dep] = resolved;
        changed = true;
      }
    }
  }

  if (changed) {
    writeJson(filePath, pkg);
    console.log(`[prepack] Resolved workspace:* internal deps in ${relPath} to ^${version}`);
  }
  return changed;
}

let resolvedAny = false;
for (const filePath of TARGET_PACKAGE_JSONS) {
  if (resolvePackageJson(filePath)) {
    resolvedAny = true;
  }
}

if (!resolvedAny && fs.existsSync(BACKUP_DIR)) {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}
