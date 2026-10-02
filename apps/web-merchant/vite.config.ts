import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app calls the API at the relative path /api, and the dev server
// forwards it. Same origin in the browser means no CORS and no API URL
// baked into the bundle. In docker-compose the target is the api service.
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000";
const proxy = { "/api": { target: apiTarget, changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy },
  preview: { port: 5174, proxy },
});
