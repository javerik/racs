// Completes the ng-packagr output in dist/ (npm run build:libs runs it after both builds):
// - the repository's LICENSE into each package,
// - dist/ng-racs-ui/styles/racs-ui.css: the design system (tokens, base, component classes) plus
//   every Tailwind utility the library's templates use, for apps without Tailwind.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import * as sass from 'sass';
import tailwindcss from 'tailwindcss';

const require = createRequire(import.meta.url);
const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(web, 'projects/ng-racs-ui');
const out = join(web, 'dist/ng-racs-ui/styles/racs-ui.css');

for (const pkg of ['ng-racs-core', 'ng-racs-ui']) {
  copyFileSync(join(web, '../LICENSE'), join(web, 'dist', pkg, 'LICENSE'));
}

const scss = sass.compile(join(lib, 'styles/racs-ui.scss'), { style: 'expanded' }).css;
const config = {
  presets: [require(join(lib, 'tailwind-preset.cjs'))],
  content: [join(lib, 'src/**/*.{html,ts}')],
};
const result = await postcss([tailwindcss(config), autoprefixer]).process(scss, { from: undefined });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `/* ng-racs-ui: the RACS design system with the utilities its components use (prebuilt). */\n${result.css}`);
console.log(`wrote ${out} (${(result.css.length / 1024).toFixed(1)} kB)`);
