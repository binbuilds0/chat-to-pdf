// Bundle src/app.js (and its dependencies) into dist/chat-to-pdf.js, a classic script that works
// when index.html is opened straight from disk (file://), where ES module scripts are blocked.
//   npm run build
import * as esbuild from 'esbuild';

const r = await esbuild.build({
  entryPoints: ['src/app.js'],
  outfile: 'dist/chat-to-pdf.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  minify: true,
  target: ['chrome110', 'safari16', 'firefox115'],
  legalComments: 'eof',
  charset: 'utf8',
  metafile: true,
  logLevel: 'warning',
});
const out = Object.entries(r.metafile.outputs)[0];
console.log(`${out[0]}  ${(out[1].bytes / 1024).toFixed(1)} KB`);
