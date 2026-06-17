const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'dist-cloudflare-pages');
const outDir = path.join(root, 'dist-cloudflare-singlefile-clean');

function read(rel) {
  return fs.readFileSync(path.join(srcDir, rel), 'utf8');
}

function escapeScript(s) {
  return s.replace(/<\/script/gi, '<\\/script');
}

function escapeStyle(s) {
  return s.replace(/<\/style/gi, '<\\/style');
}

fs.mkdirSync(outDir, { recursive: true });

let html = read('index.html');
const css = escapeStyle(read('css/app.css'));

html = html.replace(
  /<link rel="stylesheet" href="css\/app\.css\?v=[^"]*">\s*/i,
  `<style>\n${css}\n</style>\n`
);

for (const file of ['js/db.js', 'js/exchange.js', 'js/parser.js', 'js/app.js']) {
  const base = path.basename(file);
  const script = escapeScript(read(file));
  const re = new RegExp(`<script[^>]+src=["']${file.replace('/', '\\/')}\\?v=[^"']*["'][^>]*>\\s*<\\/script>\\s*`, 'i');
  html = html.replace(re, `<script data-inlined="${base}">\n${script}\n</script>\n`);
}

html = html.replace(/<script[^>]+src=["']js\/[^"']+["'][^>]*>\s*<\/script>\s*/gi, '');

fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
console.log(path.join(outDir, 'index.html'));
