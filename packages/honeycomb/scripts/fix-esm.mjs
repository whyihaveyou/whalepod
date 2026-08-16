#!/usr/bin/env node
/**
 * fix-esm.mjs — post-build ESM relative-import extension fixer.
 *
 * WHY: tsc with `moduleResolution: bundler` emits extensionless relative
 * imports (e.g. `import './context'`), which Node ESM rejects at runtime with
 * `ERR_MODULE_NOT_FOUND`. Node ESM requires explicit `.js` extensions on
 * relative specifiers. We cannot rely on tsc to auto-append (it does NOT under
 * nodenext — it requires the *source* to carry `.js`), and the frozen `src/`
 * boundary forbids touching source imports for this task. So this script
 * rewrites the EMITTED lib tree (all nested *.js files) in place:
 *   - `from './x'` / `import('./x')` / `require('./x')`  ->  `...'/x.js'`
 *   - `from '../x'` / `...`                              ->  `...'/x.js'`
 *   - dangling `.ts` endings (`'./registry.ts'`)         ->  `.js`
 * It ONLY touches relative specifiers (starts with `./` or `../`); absolute,
 * package, and builtin specifiers are left untouched.
 *
 * Idempotent: already-`.js`-ended specifiers are skipped.
 *
 * Usage:  node scripts/fix-esm.mjs [libDir]   (default: ./lib relative to this
 *         script's package root)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const libDir = resolve(process.argv[2] ?? join(pkgRoot, 'lib'));

// Match the quoted string inside a relative specifier. Handles all four forms:
//   from '<rel>'          (incl. `export * from` / `export {x} from`)
//   import('./<rel>')     (dynamic)
//   require('./<rel>')    (CJS-style, in case of mixed emit)
//   import './<rel>'      (side-effect import — no parens, no `from`)
// rel must START with ./ or ../ to be a relative module specifier.
// Groups: 1=kw, 2=whitespace, 3=paren(optional, incl. its trailing ws), 4=full quote, 5=single, 6=double.
const SPEC = /(\bimport|\bfrom|\brequire)(\s*)(\(?\s*)?('([^']*)'|"([^"]*)")/g;

// Rewrite a relative specifier to a Node-ESM-resolvable form.
// `baseDir` = the directory of the importing module, used to decide whether the
// target is a FILE (`<rel>.js`) or a DIRECTORY with an index (`<rel>/index.js`),
// because Node ESM resolves neither extensionless-nor-directory specifiers.
// Returns the rewritten specifier (or the original if nothing to change).
function fixSpecifier(raw, baseDir) {
  if (!/^\.{1,2}\//.test(raw)) return raw; // not relative → leave
  if (/\.(js|mjs|cjs|json)$/.test(raw)) return raw; // already has a resolvable ext
  // stray `.ts` ending (from source that literally wrote './x.ts')
  const withExt = raw.replace(/\.ts$/, '');
  const fileTarget = `${withExt}.js`;
  const absFile = resolve(baseDir, fileTarget);
  if (existsSync(absFile)) return fileTarget;
  // directory-index target (e.g. './transport' -> './transport/index.js')
  const dirTarget = `${withExt}/index.js`;
  if (existsSync(resolve(baseDir, dirTarget))) return dirTarget;
  // no local target found — best-effort append; later verification will flag it
  return fileTarget;
}

function fixFile(file) {
  const code = readFileSync(file, 'utf8');
  const baseDir = dirname(file);
  let changed = 0;
  const out = code.replace(SPEC, (m, kw, ws, paren, _q1, single, dbl) => {
    const raw = single ?? dbl;
    const fixed = fixSpecifier(raw, baseDir);
    if (fixed === raw) return m;
    changed++;
    const quote = single !== undefined ? `'${fixed}'` : `"${fixed}"`;
    return `${kw}${ws}${paren ?? ''}${quote}`;
  });
  if (changed > 0) {
    writeFileSync(file, out);
    return changed;
  }
  return 0;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

if (!libDir.startsWith(pkgRoot)) {
  console.error(`Refusing to run outside package root: ${libDir}`);
  process.exit(1);
}

const files = walk(libDir);
let totalChanged = 0;
let totalFiles = 0;
for (const f of files) {
  const n = fixFile(f);
  if (n > 0) {
    totalChanged += n;
    totalFiles++;
    console.log(`fixed ${n} specifier(s) in ${f}`);
  }
}
console.log(`\nfix-esm: ${totalFiles}/${files.length} files rewritten, ${totalChanged} relative specifier(s) fixed in ${libDir}`);
if (totalChanged === 0) console.log('(no change — already ESM-safe or empty)');
