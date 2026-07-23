/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        'display': ['BlackLives', 'sans-serif'],
        'sans': ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        'bg-primary': '#0E0F13',
        'bg-elevated': '#171922',
        'bg-inverse': '#F5F1EA',
        'brand-red': '#D83B3B',
        'brand-red-hover': '#B93030',
        'text-primary': '#F5F1EA',
      },
      maxWidth: {
        // 2026-06-26: Bumped from 1200 → 1440. On typical desktop/laptop
        // viewports (1440-1680px), 1200 forced 100-240px of dead space on
        // each side of every page, which makes the layout feel "zoomed in"
        // because content is squeezed into a narrow center column. 1440
        // uses the full screen on 13" MacBooks (1470 logical) and leaves
        // a comfortable gutter on larger monitors.
        'content': '1440px',
      },
    },
  },
  plugins: [],
};
