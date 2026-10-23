import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { handle } from './server/handler.ts';
import { MemoryKV } from './server/memoryStore.ts';

/** 本地开发 / 预览：用内存存储模拟 Netlify Function（无需安装 Netlify CLI） */
function devApi(): Plugin {
  const stores = { rooms: new MemoryKV(), seen: new MemoryKV() };
  const mw = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/.netlify/functions/game')) return next();
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* */ }
    const secret = (req.headers.authorization ?? '').replace(/^Bearer /, '') || null;
    const r = await handle(stores, { method: req.method ?? 'GET', query: Object.fromEntries(url.searchParams), body, secret });
    res.statusCode = r.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(r.body));
  };
  return {
    name: 'dev-api',
    configureServer(s) { s.middlewares.use(mw); },
    configurePreviewServer(s) { s.middlewares.use(mw); },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./shared/engine', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  base: './',
  plugins: [
    devApi(),
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
      workbox: {
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/\.netlify\//],
        globPatterns: ['**/*.{js,css,html,svg,png}'],
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'] },
});
