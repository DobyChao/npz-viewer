import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const BACKEND = process.env.NPZVIEW_BACKEND ?? "http://127.0.0.1:8756";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind IPv4 explicitly: resolving "localhost" picks ::1 on Windows, which
    // leaves http://127.0.0.1 refusing connections.
    host: "127.0.0.1",
    port: Number(process.env.NPZVIEW_DEV_PORT ?? 5273),
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
