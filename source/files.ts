import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { Page } from "./database.ts";

export const app = new Hono();

const fileSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
});

const updateFileSchema = z.object({
  content: z.string(),
});

// Routes
app
  .post("/", zValidator("json", fileSchema), async (c) => {
    try {
      const { name, content } = c.req.valid("json");

      const page = new Page({
        name,
        content,
      });

      await page.save();

      return c.json(page, 201);
    } catch (_error) {
      return c.json({ error: "Failed to create file" }, 500);
    }
  })
  .get("/", async (c) => {
    try {
      const files = await Page.find().sort({ createdAt: -1 });
      return c.json(files);
    } catch (_error) {
      return c.json({ error: "Failed to retrieve files" }, 500);
    }
  })
  .get("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const file = await Page.findById(id);

      if (!file) {
        return c.json({ error: "File not found" }, 404);
      }

      return c.json(file);
    } catch (_error) {
      return c.json({ error: "Failed to retrieve file" }, 500);
    }
  })
  .put("/:id", zValidator("json", updateFileSchema), async (c) => {
    try {
      const id = c.req.param("id");
      const { content } = c.req.valid("json");

      const page = await Page.findById(id);
      if (!page) {
        return c.json({ error: "File not found" }, 404);
      }

      page.content = content;
      await page.save();

      return c.json(page);
    } catch (_error) {
      return c.json({ error: "Failed to update file" }, 500);
    }
  })
  .delete("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const page = await Page.findByIdAndDelete(id);

      if (!page) {
        return c.json({ error: "File not found" }, 404);
      }

      return c.json({ message: "File deleted successfully" });
    } catch (_error) {
      return c.json({ error: "Failed to delete file" }, 500);
    }
  });
