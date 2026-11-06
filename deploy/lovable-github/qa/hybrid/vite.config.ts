import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@/lib/github-client", replacement: path.resolve("qa/github/client.ts") },
      { find: "@/hooks/use-session", replacement: path.resolve("qa/hybrid/session.ts") },
      {
        find: "@/integrations/supabase/client",
        replacement: path.resolve("qa/hybrid/supabase.ts"),
      },
      { find: "@", replacement: path.resolve("src") },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5191,
    strictPort: true,
    proxy: {
      "/api/hono": { target: "http://127.0.0.1:8789", changeOrigin: false },
      "/__test": { target: "http://127.0.0.1:8789", changeOrigin: false },
    },
  },
});
