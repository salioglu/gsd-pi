#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.prepack-backup');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'materialized-bundled-deps.json');

function depInstallPath(dep) {
  if (dep.startsWith('@')) {
    const [scope, name] = dep.split('/');
    return path.join(ROOT, 'node_modules', scope, name);
  }
  return path.join(ROOT, 'node_modules', dep);
}

function resolveSymlinkTarget(linkPath) {
  const linkTarget = fs.readlinkSync(linkPath);
  return path.isAbsolute(linkTarget) ? linkTarget : path.resolve(path.dirname(linkPath), linkTarget);
}

function materialize() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const bundled = rootPkg.bundledDependencies || [];
  const manifest = [];

  for (const dep of bundled) {
    if (dep.startsWith('@gsd/')) continue;
    const target = depInstallPath(dep);
    if (!fs.existsSync(target)) {
      throw new Error(`[materialize-bundled-deps] Missing bundled dependency in node_modules: ${dep}`);
    }
    if (!fs.lstatSync(target).isSymbolicLink()) continue;

    const linkTarget = fs.readlinkSync(target);
    const source = resolveSymlinkTarget(target);
    fs.unlinkSync(target);
    fs.cpSync(source, target, { recursive: true });
    manifest.push({ dep, linkTarget });
  }

  if (manifest.length > 0) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[materialize-bundled-deps] Materialized ${manifest.length} symlinked bundled dependencies for npm pack`);
  }
}

function restore() {
  if (!fs.existsSync(MANIFEST_PATH)) return;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  for (const entry of manifest) {
    const target = depInstallPath(entry.dep);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.symlinkSync(entry.linkTarget, target);
  }
  fs.rmSync(MANIFEST_PATH, { force: true });
  console.log('[materialize-bundled-deps] Restored symlinked bundled dependencies');
}

const mode = process.argv[2] ?? 'materialize';
if (mode === 'restore') {
  restore();
} else {
  materialize();
}
