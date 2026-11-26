import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4000,
    proxy: {
      '/ran-graphdb': {
        target: 'http://10.161.4.199:7200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ran-graphdb/, ''),
      },
      '/ran-api': {
        target: 'http://10.161.4.199:8200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ran-api/, ''),
      },
      '/ran-whatif': {
        target: 'http://10.161.4.199:8200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ran-whatif/, ''),
        timeout: 610000,
        proxyTimeout: 610000,
      },
      '/transport-api': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/transport-api/, ''),
      },
      '/graphdb': {
        target: 'http://127.0.0.1:7200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/graphdb/, ''),
      },
    },
  },
});
