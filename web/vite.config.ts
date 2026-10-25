import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 构建产物直接落到 web/dist，由 server/src/index.ts 的 express.static 托管。
 *
 * base 用 '/'：生产环境 nginx 把根路径反代到 express，不需要子路径前缀。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // import.meta.dirname 需要 Node 20.11+（项目要求 Node 22）
      '@': `${import.meta.dirname}/src`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 单页应用，压缩后前端总量不到 200KB，不需要细粒度分包
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    // 开发时把 /api 转给后端，避免 CORS
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
