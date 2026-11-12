import { readFile } from 'node:fs/promises';
import { analyzePair } from '../core/diagnostics.js';
import { summarizeUsage } from '../core/usage.js';
const fixtures=JSON.parse(await readFile(new URL('../examples/requests.synthetic.json',import.meta.url),'utf8'));
console.log(JSON.stringify({notice:fixtures.notice,offline:true,paidRequests:0,diagnostic:analyzePair(fixtures.records[0],fixtures.records[1]),ledger:summarizeUsage(fixtures.records)},null,2));
