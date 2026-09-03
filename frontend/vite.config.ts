import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { hubPlugin } from "./hub/plugin.ts";

export default defineConfig({
  // hubPlugin owns /api: it reverse-proxies to whichever backend is active
  // (the local one, or an SSH tunnel to a remote server chosen in the UI) and
  // serves the /__hub control API used by the Servers panel.
  plugins: [react(), tailwindcss(), hubPlugin()],
  server: {
    // Bind IPv4 explicitly: resolving "localhost" picks ::1 on Windows, which
    // leaves http://127.0.0.1 refusing connections.
    host: "127.0.0.1",
    port: Number(process.env.NPZVIEW_DEV_PORT ?? 5273),
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
