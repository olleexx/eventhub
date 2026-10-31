// Dependency-free syntax check of every project JS file (`node --check`). Does not need node_modules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const roots = ['src', 'scripts', 'test', 'public/js'];
let bad = 0, n = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  if (!p.endsWith('.js')) return;
  n++;
  try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); } catch (err) { bad++; console.error(`SYNTAX ERROR ${p}\n${err.stderr}`); }
});
roots.filter(fs.existsSync).forEach(walk);
console.log(`${n} files checked, ${bad} with errors`);
process.exit(bad ? 1 : 0);
