// Copies the Monaco editor's browser files into public/ after `npm install`.
//
// WHY: by default the editor is downloaded from a CDN at run time. Serving our
// own copy means the app works offline and always uses the installed version.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const to = join(root, 'public', 'monaco', 'vs');

if (existsSync(from)) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log('Copied Monaco editor files to public/monaco/vs');
}
