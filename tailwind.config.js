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
        'content': '1200px',
      },
    },
  },
  plugins: [],
};
