const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(srcRel, destRel = srcRel) {
  const src = path.join(root, srcRel);
  const dest = path.join(outDir, destRel);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcRel) {
  const src = path.join(root, srcRel);
  const dest = path.join(outDir, srcRel);
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(srcRel, entry.name);
    if (entry.isDirectory()) copyDir(from);
    else copyFile(from);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
ensureDir(outDir);

copyFile('index.html');
copyDir('css');
copyDir('js');

fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf8');
fs.writeFileSync(
  path.join(outDir, 'README.txt'),
  [
    'CD-BI GitHub Pages static build.',
    'Publish this docs/ directory from the main branch in GitHub Pages.',
    'Data is stored in Supabase; uploaded business files are not included in this folder.',
    '',
  ].join('\n'),
  'utf8'
);

console.log(outDir);
