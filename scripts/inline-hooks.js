// Build step: inline login_hooks.js (verbatim) into the preload template.
// Produces preload/preload.gen.js which the BrowserViews actually load.
// Keeps sandbox:true working (preload can't require('fs') at runtime under sandbox).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const hooksPath = path.join(root, 'preload', 'login_hooks.js');
const tplPath = path.join(root, 'preload', 'preload.template.js');
const outPath = path.join(root, 'preload', 'preload.gen.js');

const hooks = fs.readFileSync(hooksPath, 'utf8');
const tpl = fs.readFileSync(tplPath, 'utf8');

if (!tpl.includes('/*__HOOKS__*/')) {
  throw new Error('preload.template.js missing /*__HOOKS__*/ placeholder');
}
const out = tpl.replace('/*__HOOKS__*/', JSON.stringify(hooks));
fs.writeFileSync(outPath, out);
console.log('preload.gen.js written (' + out.length + ' bytes)');
