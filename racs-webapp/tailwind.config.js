/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('./projects/ng-racs-ui/tailwind-preset.cjs')],
  // The UI library's sources (a consumer of the package lists node_modules/ng-racs-ui instead).
  content: ['./src/**/*.{html,ts}', './projects/ng-racs-ui/src/**/*.{html,ts}'],
};
