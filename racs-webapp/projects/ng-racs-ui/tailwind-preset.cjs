const plugin = require('tailwindcss/plugin');

/**
 * The RACS design system's Tailwind 3 preset: the semantic colour tokens (values in
 * styles/_tokens.scss), the IBM Plex fonts, `text-2xs`, the theme's radius and the `mobile:` /
 * `desktop:` variants. Use it with `presets: [require('ng-racs-ui/tailwind-preset.cjs')]` and the
 * library's files in `content`.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: [],
  theme: {
    extend: {
      // Semantic tokens only; the values live as CSS variables in styles/_tokens.scss.
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        'line-strong': 'rgb(var(--line-strong) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        faint: 'rgb(var(--faint) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        ok: 'rgb(var(--ok) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        err: 'rgb(var(--err) / <alpha-value>)',
        'series-1': 'rgb(var(--series-1) / <alpha-value>)',
        'series-2': 'rgb(var(--series-2) / <alpha-value>)',
        'series-3': 'rgb(var(--series-3) / <alpha-value>)',
        'series-4': 'rgb(var(--series-4) / <alpha-value>)',
        'series-5': 'rgb(var(--series-5) / <alpha-value>)',
        'series-6': 'rgb(var(--series-6) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        // 2px, 6px in the Light theme (--radius in styles/_tokens.scss).
        DEFAULT: 'var(--radius)',
      },
    },
  },
  plugins: [
    // The layout mode (LayoutService) sets data-layout on <html>. The shell switches on it rather
    // than on width, so the user can override the detection.
    plugin(({ addVariant }) => {
      addVariant('mobile', '[data-layout="mobile"] &');
      addVariant('desktop', '[data-layout="desktop"] &');
    }),
  ],
};
