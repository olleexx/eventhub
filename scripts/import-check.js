// Static check: every named import from a relative module must be exported by that module.
// Cheap substitute for running the app when dependencies cannot be installed.
import fs from 'node:fs';
import path from 'node:path';
const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); });
['src', 'scripts', 'test'].filter(fs.existsSync).forEach(walk);

const exportsOf = (file) => {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)) out.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop(); if (n) out.add(n); });
  if (/export\s+default/.test(src)) out.add('default');
  return out;
};
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[3]);
    if (!fs.existsSync(target)) { console.error(`${f}: missing module ${m[3]}`); bad++; continue; }
    const ex = exportsOf(target);
    if (m[1] && !ex.has('default')) { console.error(`${f}: ${m[3]} has no default export`); bad++; }
    for (const name of (m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (!ex.has(name)) { console.error(`${f}: '${name}' is not exported by ${m[3]}`); bad++; }
    }
  }
}
console.log(`import check: ${files.length} files, ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
