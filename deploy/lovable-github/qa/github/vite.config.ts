import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@/lib/hono-client", replacement: path.resolve("qa/github/hono.ts") },
      { find: "@/hooks/use-session", replacement: path.resolve("qa/github/session.ts") },
      { find: "@/lib/github-client", replacement: path.resolve("qa/github/client.ts") },
      { find: "@/lib/github-export", replacement: path.resolve("qa/github/export.ts") },
      { find: "@", replacement: path.resolve("src") },
    ],
  },
  server: { host: "127.0.0.1", port: 5189, strictPort: true },
});
