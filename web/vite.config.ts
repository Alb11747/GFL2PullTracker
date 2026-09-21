import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [sveltekit()],
  // Only the private image-build path generates maps; ordinary builds expose none.
  build: { sourcemap: process.env.POSTHOG_SOURCEMAPS === '1' ? 'hidden' : false },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' }
});
