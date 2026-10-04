import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

try { process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env")); } catch {}

const server = {
  port: Number(process.env.WEB_PORT ?? 5199),
  ...(process.env.EXPOSE && { host: true, allowedHosts: true as const }),
  proxy: { "/api": `http://127.0.0.1:${process.env.PORT ?? 3001}` },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    chunkSizeWarningLimit: 800, // lazy md-editor ~714 kB
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/ }] },
      },
    },
  },
  server,
  preview: server,
});
