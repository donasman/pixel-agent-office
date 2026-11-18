// Assembles the GitHub Pages site in _site/: site/ plus the office's own drawing code and art from public/, so the demo
// on the site is always the real office. Run by .github/workflows/pages.yml; run it locally to preview.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..'), out = path.join(root, '_site');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
fs.copyFileSync(path.join(root, 'public', 'office.js'), path.join(out, 'office.js'));
fs.cpSync(path.join(root, 'public', 'art'), path.join(out, 'art'), { recursive: true });
console.log(`site built in ${out}`);
