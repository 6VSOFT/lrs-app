import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@engine': fileURLToPath(new URL('./shared/engine', import.meta.url)), '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '狼人杀自动法官',
        short_name: '狼人杀',
        description: '12 人预女猎白 · 无需真人法官',
        lang: 'zh-CN',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { navigateFallback: 'index.html', globPatterns: ['**/*.{js,css,html,svg,png}'] },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'] },
});
