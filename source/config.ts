import { Hono } from "hono";
import { Models } from "@travisennis/acai-core";

const app = new Hono();

app.get("/", (c) => {
  try {
    return c.json({
      models: Models,
    });
  } catch (_error) {
    return c.json({ error: "Failed to retrieve configuration" }, 500);
  }
});

export default app;
