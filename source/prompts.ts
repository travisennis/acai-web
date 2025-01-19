import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

const baseDir = "/Users/travisennis/Github";
const PROMPTS_DIR = path.join(baseDir, "prompts");

// Ensure prompts directory exists
if (!existsSync(PROMPTS_DIR)) {
  await fs.mkdir(PROMPTS_DIR, { recursive: true });
}

interface PromptMetadata {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

const promptSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
});

const updatePromptSchema = z.object({
  content: z.string(),
});

// Helper functions
async function getAllPrompts(): Promise<PromptMetadata[]> {
  const files = await fs.readdir(PROMPTS_DIR);
  const promptMetadata: PromptMetadata[] = [];

  for (const file of files) {
    if (file.endsWith(".md")) {
      const content = await fs.readFile(path.join(PROMPTS_DIR, file), "utf-8");
      const id = file.replace(".md", "");
      const stats = await fs.stat(path.join(PROMPTS_DIR, file));

      promptMetadata.push({
        id,
        name: file.replace(".md", ""),
        content,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
      });
    }
  }

  return promptMetadata.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

async function getPrompt(id: string): Promise<PromptMetadata | null> {
  const filePath = path.join(PROMPTS_DIR, `${id}.md`);
  if (!existsSync(filePath)) {
    return null;
  }

  const content = await fs.readFile(filePath, "utf-8");
  const stats = await fs.stat(filePath);

  return {
    id,
    name: id,
    content,
    createdAt: stats.birthtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
  };
}

// Routes
app
  .post("/", zValidator("json", promptSchema), async (c) => {
    try {
      const { name, content } = c.req.valid("json");
      const id = name.toLowerCase().replace(/\s+/g, "-");
      const timestamp = new Date().toISOString();

      const filePath = path.join(PROMPTS_DIR, `${id}.md`);

      const fileExists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        await fs.writeFile(filePath, content, "utf-8");
      } else {
        throw new Error(`File already exists: ${filePath}.`);
      }

      const promptMetadata: PromptMetadata = {
        id,
        name,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return c.json(promptMetadata, 201);
    } catch (error) {
      return c.json(
        { error: `Failed to create prompt: ${(error as Error).message}` },
        500,
      );
    }
  })
  .get("/", async (c) => {
    try {
      const prompts = await getAllPrompts();
      return c.json(prompts);
    } catch (_error) {
      return c.json({ error: "Failed to retrieve prompts" }, 500);
    }
  })
  .get("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const prompt = await getPrompt(id);

      if (!prompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      return c.json(prompt);
    } catch (_error) {
      return c.json({ error: "Failed to retrieve prompt" }, 500);
    }
  })
  .put("/:id", zValidator("json", updatePromptSchema), async (c) => {
    try {
      const id = c.req.param("id");
      const { content } = c.req.valid("json");

      const existingPrompt = await getPrompt(id);
      if (!existingPrompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      await fs.writeFile(path.join(PROMPTS_DIR, `${id}.md`), content, "utf-8");

      const updatedPrompt = await getPrompt(id);
      return c.json(updatedPrompt);
    } catch (_error) {
      return c.json({ error: "Failed to update prompt" }, 500);
    }
  })
  .delete("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const filePath = path.join(PROMPTS_DIR, `${id}.md`);

      if (!existsSync(filePath)) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      await fs.unlink(filePath);
      return c.json({ message: "Prompt deleted successfully" });
    } catch (_error) {
      return c.json({ error: "Failed to delete prompt" }, 500);
    }
  });

export default app;
