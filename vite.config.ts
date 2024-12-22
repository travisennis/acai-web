import devServer from "@hono/vite-dev-server";
import nodeAdapter from "@hono/vite-dev-server/node";
import build from "@hono/vite-build/node";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  if (mode === "client") {
    return {
      esbuild: {
        jsxImportSource: "hono/jsx/dom", // Optimized for hono/jsx/dom
      },
      build: {
        rollupOptions: {
          input: {
            "instruct-client": "./source/instruct-client.tsx",
          },
          output: {
            entryFileNames: "static/[name].js",
          },
        },
      },
    };
  }
  return {
    define: {
      "process.env": process.env,
    },
    plugins: [
      build({
        entry: "source/index.tsx",
        minify: false,
      }),
      devServer({
        adapter: nodeAdapter,
        entry: "source/index.tsx",
      }),
    ],
  };
});
