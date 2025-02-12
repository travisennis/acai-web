import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "redis";
import { Server } from "socket.io";
import mongoose, { connect } from "mongoose";
import { app as chatApp } from "./chat.ts";
import { app as configApp } from "./config.ts";
import { app as filesApp } from "./files.ts";
import { app as historyApp } from "./history.ts";
import { app as instructApp } from "./instruct.ts";
import { app as promptsApp } from "./prompts.ts";

const app = new Hono();

app.use("/*", cors());

app.use("/public/*", serveStatic({ root: "./" }));

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  "/ws",
  upgradeWebSocket((_c) => {
    return {
      onOpen(event, ws) {
        console.info(`Open from client: ${event.type}`);
        ws.send("Hello from server!");
      },
      onMessage(event, ws) {
        console.info(`Message from client: ${event.data}`);
        ws.send("Hello from server!");
      },
      onClose: () => {
        console.info("Connection closed");
      },
    };
  }),
);

const routes = app
  .route("/instruct", instructApp)
  .route("/chat", chatApp)
  .route("/files", filesApp)
  .route("/prompts", promptsApp)
  .route("/history", historyApp)
  .route("/config", configApp);

const honoServer = serve(
  {
    fetch: app.fetch,
    // createServer,
    port: 8080,
  },
  async (info) => {
    console.info(`Server started: ${info.address}:${info.port}`);

    if (process.env.REDIS_HOST) {
      console.info(`Starting redis server: ${process.env.REDIS_HOST}`);
      const redisClient = createClient({
        username: process.env.REDIS_USERNAME,
        password: process.env.REDIS_PASSWORD,
        socket: {
          host: process.env.REDIS_HOST,
          port: Number.parseInt(process.env.REDIS_PORT ?? "0"),
          connectTimeout: 2000,
          reconnectStrategy: (retries: number) => {
            if (retries > 20) {
              return new Error("Too many retries.");
            }
            return Math.min(retries * 50, 1000);
          },
        },
      });

      redisClient.on("error", (err: Error) =>
        console.error("Redis Client Error:", err),
      );

      await redisClient.connect();

      console.info("Starting socket server");
      const io = new Server(honoServer, {
        path: "/ws2",
        adapter: createAdapter(redisClient),
        serveClient: false,
        cors: {
          origin: "*",
          methods: ["GET", "POST"],
        },
      });

      setInterval(() => {
        io.emit("ping");
      }, 15000);
    }

    if (process.env.MONGO_ATLAS_URI) {
      console.info("Starting mongo server");
      await connect(process.env.MONGO_ATLAS_URI);
    }
  },
);

// const server = serve(app, (info) => console.log(`Server started: ${info.port}`));
injectWebSocket(honoServer);

export type AppType = typeof routes;

// Graceful shutdown
process.on("SIGTERM", async () => {
  try {
    await mongoose.disconnect();
  } catch (error) {
    console.error("Error during Mongoose shutdown:", error);
  }
  process.exit(0);
});
