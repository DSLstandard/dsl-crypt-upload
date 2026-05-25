import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import fs from "fs"
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import pathlib from 'path'

/*
 * https://vite.dev/config/
 *
 * NOTE: The vite server is only used for development. In production, the client
 * assets are built statically.
 */
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,

    /*
     * Required for bypass browser security restrictions in local development
     *
     * You have to set these up yourself with mkcert, etc.
     */
    https: {
      key: fs.readFileSync("./dev/mkcert-key.pem"),
      cert: fs.readFileSync("./dev/mkcert.pem"),
    }
  },
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    alias: {
      "@": pathlib.resolve(__dirname, "./src"),
    },
  },
})
