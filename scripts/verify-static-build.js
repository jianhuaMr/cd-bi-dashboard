const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs');
const requiredFiles = [
  'index.html',
  'css/app.css',
  'js/db.js',
  'js/exchange.js',
  'js/parser.js',
  'js/app.js',
  '.nojekyll',
];

function fail(message) {
  throw new Error(message);
}

for (const rel of requiredFiles) {
  const full = path.join(outDir, rel);
  if (!fs.existsSync(full)) fail(`Missing required file: docs/${rel}`);
  if (rel !== '.nojekyll' && fs.statSync(full).size <= 0) fail(`Empty required file: docs/${rel}`);
}

const index = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const db = fs.readFileSync(path.join(outDir, 'js/db.js'), 'utf8');

for (const rel of ['css/app.css', 'js/db.js', 'js/exchange.js', 'js/parser.js', 'js/app.js']) {
  const bare = rel.replace(/\\/g, '/');
  if (!index.includes(bare)) fail(`index.html does not reference ${bare}`);
}

if (!index.includes('<title>CD-BI 月度清算分析</title>')) {
  fail('index.html title is not valid UTF-8 Chinese text');
}

if (!index.includes('欢迎使用 CD-BI')) {
  fail('index.html body text is not valid UTF-8 Chinese text');
}

if (!db.includes("url: 'https://loooajojyuxsgbjjzzvs.supabase.co'")) {
  fail('Supabase URL missing from docs/js/db.js');
}

if (!db.includes("key: 'sb_publishable_udQnr2K3DDnnlCLaQENvsw_ZKfxniVv'")) {
  fail('Supabase publishable key missing from docs/js/db.js');
}

if (!db.includes('on_conflict=store_name,record_key')) {
  fail('Supabase upsert conflict fix missing from docs/js/db.js');
}

if (!db.includes('return=minimal')) {
  fail('Supabase empty-response fix missing from docs/js/db.js');
}

const summary = {
  outDir,
  files: requiredFiles.length,
  indexBytes: fs.statSync(path.join(outDir, 'index.html')).size,
  cssBytes: fs.statSync(path.join(outDir, 'css/app.css')).size,
  appBytes: fs.statSync(path.join(outDir, 'js/app.js')).size,
  supabaseFix: true,
  utf8Text: true,
};

console.log(JSON.stringify(summary, null, 2));
