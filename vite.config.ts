import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(),
           {
      name: 'html-transform',
      transformIndexHtml(html) {
        return html.replace(/<title>(.*?)<\/title>/, '<title>Inventory</title>')
      }}],
  server: {
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "inventory-deploy-sable.vercel.app",
      "5zxjm6-5173.csb.app", // 👈 tu dominio público en CodeSandbox
    ],
  },
});
