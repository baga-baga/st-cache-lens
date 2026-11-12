import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install, parseArgs } from '../scripts/install.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-lens-install-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const st = path.join(base, 'Silly Tavern'), sourceRoot = path.join(base, 'package');
  await fs.mkdir(st); await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(st, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.19.0' }));
  await fs.writeFile(path.join(st, 'config.yaml'), 'enableServerPlugins: false\n');
  for (const dir of ['core', 'adapters', 'server']) { await fs.mkdir(path.join(sourceRoot, dir)); await fs.writeFile(path.join(sourceRoot, dir, 'index.mjs'), '// fixture\n'); }
  for (const file of ['index.js', 'style.css']) await fs.writeFile(path.join(sourceRoot, file), 'fixture');
  await fs.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify({ display_name: 'Cache Lens' }));
  return { base, st, sourceRoot };
}

test('cross-platform paths with spaces install frontend and server without config edit', async t => {
  const f = await fixture(t), result = await install({ ...f, frontend: true, server: true });
  assert.equal(result.components.length, 2);
  const server = JSON.parse(await fs.readFile(path.join(f.st, 'plugins/cache-lens/package.json'), 'utf8'));
  assert.equal(server.main, 'server/index.mjs');
  assert.equal(await fs.readFile(path.join(f.st, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
});

test('second install makes recoverable backup', async t => {
  const f = await fixture(t); await install(f);
  await fs.writeFile(path.join(f.sourceRoot, 'index.js'), 'new version');
  const result = await install(f);
  assert.equal(await fs.readFile(path.join(result.components[0].backup, 'index.js'), 'utf8'), 'fixture');
  assert.equal(await fs.readFile(path.join(result.components[0].destination, 'index.js'), 'utf8'), 'new version');
});

test('reject traversal, unknown destination, old version and bad args', async t => {
  const f = await fixture(t);
  await assert.rejects(install({ ...f, user: '../someone' }), /用户目录名/);
  const dest = path.join(f.st, 'data/default-user/extensions/st-cache-lens');
  await fs.mkdir(dest, { recursive: true }); await fs.writeFile(path.join(dest, 'important.txt'), 'keep');
  await assert.rejects(install(f), /拒绝覆盖/);
  assert.equal(await fs.readFile(path.join(dest, 'important.txt'), 'utf8'), 'keep');
  await fs.writeFile(path.join(f.st, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  await assert.rejects(install(f), /1.19.0/);
  assert.throws(() => parseArgs(['--st']), /缺少参数/);
  assert.throws(() => parseArgs(['--unknown']), /未知参数/);
});

test('reject source and destination symlinks', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.sourceRoot, 'index.js'), path.join(f.sourceRoot, 'core/link.js'));
  await assert.rejects(install(f), /符号链接/);
  await fs.unlink(path.join(f.sourceRoot, 'core/link.js'));
  await fs.symlink(f.sourceRoot, path.join(f.st, 'data'), 'dir');
  await assert.rejects(install(f), /普通目录/);
});

test('compare-and-swap detects concurrent target edits before replacing', async t => {
  const f = await fixture(t); await install(f);
  const dest = path.join(f.st, 'data/default-user/extensions/st-cache-lens/index.js');
  await assert.rejects(install({ ...f, beforeCommit: async () => fs.writeFile(dest, 'concurrent change') }), /期间目标被修改/);
  assert.equal(await fs.readFile(dest, 'utf8'), 'concurrent change');
  const siblings = await fs.readdir(path.dirname(path.dirname(dest)));
  assert.ok(!siblings.some(name => name.includes('.staging-')));
});

test('failed second component restores both pre-install components', async t => {
  const f = await fixture(t); await install({ ...f, frontend: true, server: true });
  await fs.writeFile(path.join(f.sourceRoot, 'index.js'), 'replacement');
  await assert.rejects(install({ ...f, frontend: true, server: true, beforeCommit: async entries => {
    await fs.rm(entries.find(entry => entry.kind === 'server').stage, { recursive: true });
  } }), /ENOENT/);
  assert.equal(await fs.readFile(path.join(f.st, 'data/default-user/extensions/st-cache-lens/index.js'), 'utf8'), 'fixture');
  assert.equal(await fs.readFile(path.join(f.st, 'plugins/cache-lens/server/index.mjs'), 'utf8'), '// fixture\n');
});
