import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Not CRM_PORT: the dev UI must never proxy to the installed app.
const DEV_PORT = process.env.ALFRED_DEV_PORT ?? '29982'

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5210,
    // /config carries the publishable key the browser needs before sign-in,
    // so it has to be proxied alongside the gated API.
    proxy: {
      '/api': `http://127.0.0.1:${DEV_PORT}`,
      '/config': `http://127.0.0.1:${DEV_PORT}`,
    },
  },
})
