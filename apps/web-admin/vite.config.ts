import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same arrangement as the other two apps: the app calls /api and the
// dev server forwards it, so the browser sees one origin — which is
// also what makes the session cookie work without any CORS exception.
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000";
const proxy = { "/api": { target: apiTarget, changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5175, proxy },
  preview: { port: 5175, proxy },
});
