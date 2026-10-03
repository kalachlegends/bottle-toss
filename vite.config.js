import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// По умолчанию — обычная сборка для GitHub Pages (относительные пути, ассеты отдельными файлами).
// SINGLE=1 — один самодостаточный index.html (можно открыть без сервера и переслать файлом).
const single = process.env.SINGLE === '1';

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.glb'],
  plugins: single ? [viteSingleFile()] : [],
  build: {
    target: 'es2022',
    assetsInlineLimit: single ? 100_000_000 : 0,
    chunkSizeWarningLimit: 10_000,
  },
  server: { host: true, port: 5180 },
});
