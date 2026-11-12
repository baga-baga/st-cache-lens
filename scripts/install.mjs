#!/usr/bin/env node
/** Offline, cross-platform installer. No npm install, shell commands, or configuration edits. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'CACHE_LENS_INSTALL.json';
const FRONTEND = ['manifest.json', 'index.js', 'style.css', 'core', 'adapters'];
const SERVER = ['server', 'core'];

async function exists(p) {
  try { await fs.lstat(p); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function assertPlainTree(p) {
  const stat = await fs.lstat(p);
  if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接：${p}`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`拒绝特殊文件：${p}`);
  if (stat.isDirectory()) for (const name of await fs.readdir(p)) await assertPlainTree(path.join(p, name));
}

async function assertSafeDestination(root, destination) {
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('目标目录越界');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (await exists(current)) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目标路径不是普通目录：${current}`);
    }
  }
}

async function treeHash(root) {
  if (!(await exists(root))) return null;
  const hash = createHash('sha256');
  async function walk(current) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接：${current}`);
    hash.update(path.relative(root, current));
    hash.update('\0');
    if (stat.isDirectory()) {
      hash.update('directory\0');
      for (const name of (await fs.readdir(current)).sort()) await walk(path.join(current, name));
    } else if (stat.isFile()) {
      hash.update('file\0');
      hash.update(await fs.readFile(current));
    } else throw new Error(`拒绝特殊文件：${current}`);
  }
  await walk(root);
  return hash.digest('hex');
}

export function parseArgs(args) {
  const result = { frontend: false, server: false, user: 'default-user' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--frontend') result.frontend = true;
    else if (arg === '--server') result.server = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--st' || arg === '--user') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} 缺少参数`);
      result[arg === '--st' ? 'st' : 'user'] = args[++i];
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!result.frontend && !result.server) result.frontend = true;
  return result;
}

/** Install to a stopped ST instance. beforeCommit is solely an injectable test hook. */
export async function install({ st, frontend = true, server = false, user = 'default-user', sourceRoot = PACKAGE_ROOT, beforeCommit }) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更新版本');
  if (!st) throw new Error('请用 --st 指定 SillyTavern 目录');
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) throw new Error('用户目录名仅允许字母、数字、下划线和短横线');
  if (!frontend && !server) throw new Error('未选择安装组件');
  const root = await fs.realpath(path.resolve(st));
  const source = await fs.realpath(path.resolve(sourceRoot));
  const stPackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (String(stPackage.name).toLowerCase() !== 'sillytavern') throw new Error('目标不是 SillyTavern 根目录');
  const [major, minor] = String(stPackage.version).split('.').map(Number);
  if (!Number.isInteger(major) || major < 1 || (major === 1 && minor < 19)) throw new Error('此安装包要求 SillyTavern 1.19.0 或更新版本；其他版本请先核验 API');
  const components = [];
  if (frontend) components.push({ kind: 'frontend', destination: path.join(root, 'data', user, 'extensions', 'st-cache-lens'), files: FRONTEND });
  if (server) components.push({ kind: 'server', destination: path.join(root, 'plugins', 'cache-lens'), files: SERVER });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const prepared = [];
  try {
    for (const component of components) {
      await assertSafeDestination(root, component.destination);
      for (const name of component.files) await assertPlainTree(path.join(source, name));
      if (await exists(component.destination)) {
        await assertPlainTree(component.destination);
        let known = false;
        try { known = JSON.parse(await fs.readFile(path.join(component.destination, MARKER), 'utf8')).package === 'st-cache-lens'; } catch {}
        try { known ||= /cache.?lens/i.test(JSON.parse(await fs.readFile(path.join(component.destination, 'manifest.json'), 'utf8')).display_name); } catch {}
        if (!known) throw new Error(`目标已存在且无法确认为 Cache Lens，拒绝覆盖：${component.destination}`);
      }
      const initialHash = await treeHash(component.destination);
      await fs.mkdir(path.dirname(component.destination), { recursive: true });
      const stage = `${component.destination}.staging-${stamp}`;
      await fs.mkdir(stage);
      // Backups must live OUTSIDE extension/plugin scan directories, otherwise ST could load both versions.
      const backup = initialHash ? path.join(root, 'data', user, 'cache-lens-install-backups', stamp, component.kind) : null;
      if (backup) { await assertSafeDestination(root, backup); await fs.mkdir(path.dirname(backup), { recursive: true }); }
      const entry = { ...component, stage, initialHash, backup, committed: false, movedOld: false };
      prepared.push(entry);
      for (const name of component.files) await fs.cp(path.join(source, name), path.join(stage, name), { recursive: true, dereference: false, errorOnExist: true, force: false });
      if (component.kind === 'server') {
        await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'cache-lens-server', type: 'module', main: 'server/index.mjs', engines: { node: '>=20' } }, null, 2) + '\n');
      }
      await fs.writeFile(path.join(stage, MARKER), JSON.stringify({ package: 'st-cache-lens', installedAt: new Date().toISOString(), component: component.kind, targetVersion: stPackage.version }, null, 2) + '\n');
      await assertPlainTree(stage);
    }
    if (beforeCommit) await beforeCommit(prepared);
    // Compare ALL components before moving any of them; the user should stop ST for installation.
    for (const entry of prepared) {
      await assertSafeDestination(root, entry.destination);
      if (await treeHash(entry.destination) !== entry.initialHash) throw new Error(`安装期间目标被修改，已取消：${entry.destination}`);
    }
    for (const entry of prepared) {
      if (entry.backup) { await fs.rename(entry.destination, entry.backup); entry.movedOld = true; }
      await fs.rename(entry.stage, entry.destination);
      entry.committed = true;
    }
    return { version: stPackage.version, verifiedVersion: '1.19.0', components: prepared.map(({ kind, destination, backup }) => ({ kind, destination, backup })), serverConfigRequired: server };
  } catch (error) {
    const restoreErrors = [];
    for (const entry of prepared.reverse()) {
      try {
        if (entry.committed) await fs.rm(entry.destination, { recursive: true, force: true });
        if (entry.movedOld) await fs.rename(entry.backup, entry.destination);
        await fs.rm(entry.stage, { recursive: true, force: true });
      } catch (restoreError) { restoreErrors.push(restoreError.message); }
    }
    if (restoreErrors.length) error.message += `；恢复失败：${restoreErrors.join('；')}`;
    throw error;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log('先停止酒馆。用法：node scripts/install.mjs --st /path/to/SillyTavern [--frontend] [--server] [--user default-user]\n默认安装前端。已有 Cache Lens 会备份；不会修改 config.yaml。');
    else {
      const result = await install(args);
      console.log(JSON.stringify(result, null, 2));
      if (result.version !== result.verifiedVersion) console.log('提示：已核验源码版本为 1.19.0；此目标版本须做事件与请求转换兼容检查。');
      if (result.serverConfigRequired) console.log('请在酒馆根目录 config.yaml 中设置 enableServerPlugins: true，然后重启酒馆。不要修改 default/config.yaml。');
      else console.log('重启酒馆或刷新页面，在扩展设置中打开 Cache Lens。');
    }
  } catch (error) {
    console.error(`安装失败：${error.message}`);
    process.exitCode = 1;
  }
}
