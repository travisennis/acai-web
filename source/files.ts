import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

const FILES_DIR = path.join("data", "files");

// Ensure files directory exists
if (!existsSync(FILES_DIR)) {
  await fs.mkdir(FILES_DIR, { recursive: true });
}

interface FileMetadata {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

const fileSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
});

const updateFileSchema = z.object({
  content: z.string(),
});

// Helper functions
async function getAllFiles(): Promise<FileMetadata[]> {
  const files = await fs.readdir(FILES_DIR);
  const fileMetadata: FileMetadata[] = [];

  for (const file of files) {
    if (file.endsWith(".json")) {
      const content = await fs.readFile(path.join(FILES_DIR, file), "utf-8");
      fileMetadata.push(JSON.parse(content));
    }
  }

  return fileMetadata.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

async function getFile(id: string): Promise<FileMetadata | null> {
  const filePath = path.join(FILES_DIR, `${id}.json`);
  if (!existsSync(filePath)) {
    return null;
  }

  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content);
}

// Routes
app
  .post("/", zValidator("json", fileSchema), async (c) => {
    try {
      const { name, content } = c.req.valid("json");
      const id = Date.now().toString();
      const timestamp = new Date().toISOString();

      const fileMetadata: FileMetadata = {
        id,
        name,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await fs.writeFile(
        path.join(FILES_DIR, `${id}.json`),
        JSON.stringify(fileMetadata, null, 2),
        "utf-8",
      );

      return c.json(fileMetadata, 201);
    } catch (_error) {
      return c.json({ error: "Failed to create file" }, 500);
    }
  })
  .get("/", async (c) => {
    try {
      const files = await getAllFiles();
      return c.json(files);
    } catch (_error) {
      return c.json({ error: "Failed to retrieve files" }, 500);
    }
  })
  .get("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const file = await getFile(id);

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

      const existingFile = await getFile(id);
      if (!existingFile) {
        return c.json({ error: "File not found" }, 404);
      }

      const updatedFile: FileMetadata = {
        ...existingFile,
        content,
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(FILES_DIR, `${id}.json`),
        JSON.stringify(updatedFile, null, 2),
        "utf-8",
      );

      return c.json(updatedFile);
    } catch (_error) {
      return c.json({ error: "Failed to update file" }, 500);
    }
  })
  .delete("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const filePath = path.join(FILES_DIR, `${id}.json`);

      if (!existsSync(filePath)) {
        return c.json({ error: "File not found" }, 404);
      }

      await fs.unlink(filePath);
      return c.json({ message: "File deleted successfully" });
    } catch (_error) {
      return c.json({ error: "Failed to delete file" }, 500);
    }
  });

export default app;
