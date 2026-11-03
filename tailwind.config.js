/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 配色只在这里出现一次；CSS 里对应的 --po-* 令牌见 src/index.css
        ink: '#08080b',
        bone: '#f2eae0',
        crimson: '#e0393c',
        amber: '#ffb347',
        halo: '#ffd98a',
      },
      fontFamily: {
        hud: ['Consolas', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
