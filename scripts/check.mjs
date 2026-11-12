import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let count=0;
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(['node_modules','.git'].includes(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(/\.(?:js|mjs)$/.test(file)){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status)throw new Error(r.stderr);count++;}else if(file.endsWith('.json'))JSON.parse(await readFile(file,'utf8'));}}
await walk(root);console.log(JSON.stringify({syntaxFiles:count,json:'valid'}));
