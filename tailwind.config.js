/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 配色只在这里出现一次；CSS 里对应的 --po-* 令牌见 src/index.css
        paper: '#eeeeea',
        card: '#ffffff',
        ink: '#17181a',
        crimson: '#b02a2a',
        cyan: '#12a7bd',
        gold: '#e8b94a',
      },
      fontFamily: {
        hud: ['Consolas', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
