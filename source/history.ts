import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import type { UserContent } from "ai";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

interface Message {
  role: string;
  content: UserContent;
}

interface Interaction {
  prompt: Message[];
  response: string;
  id: number;
}

interface PaginatedResult {
  interactions: {
    id: number;
    preview: string;
  }[];
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalItems: number;
  };
}

async function getTotalLines(filePath: string): Promise<number> {
  if (!existsSync(filePath)) {
    return 0;
  }
  const content = await fs.readFile(filePath, "utf-8");
  return content.trim().split("\n").length;
}

async function readPaginatedLines(
  filePath: string,
  page: number,
  pageSize: number,
): Promise<Interaction[]> {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const startIndex = Math.max(lines.length - page * pageSize, 0);
  const endIndex = Math.max(lines.length - (page - 1) * pageSize, 0);
  const selectedLines = lines.slice(startIndex, endIndex);

  return selectedLines.map((line, index) => ({
    ...JSON.parse(line),
    id: startIndex + index + 1,
  }));
}

async function readSpecificLine(
  filePath: string,
  lineNumber: number,
): Promise<Interaction | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");

  if (lineNumber < 1 || lineNumber > lines.length) {
    return null;
  }

  return JSON.parse(lines[lineNumber - 1]);
}

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(10),
});

app
  .get("/", zValidator("query", querySchema), async (c) => {
    try {
      const { page, pageSize } = c.req.valid("query");
      const filePath = path.join("data", "messages.jsonl");

      const totalItems = await getTotalLines(filePath);
      const totalPages = Math.ceil(totalItems / pageSize);

      const interactions = await readPaginatedLines(filePath, page, pageSize);

      const formattedInteractions = interactions.map((interaction) => {
        return {
          id: interaction.id,
          preview: interaction.response
            ? interaction.response.substring(0, 100) +
              (interaction.response.length > 100 ? "..." : "")
            : "",
        };
      });

      const result: PaginatedResult = {
        interactions: formattedInteractions,
        pagination: {
          page,
          pageSize,
          totalPages,
          totalItems,
        },
      };

      return c.json(result);
    } catch (_error) {
      return c.json({ error: "Failed to read history" }, 500);
    }
  })
  .get("/:id", async (c) => {
    try {
      const id = Number.parseInt(c.req.param("id"));
      if (Number.isNaN(id)) {
        return c.json({ error: "Invalid ID" }, 400);
      }

      const filePath = path.join("data", "messages.jsonl");
      const interaction = await readSpecificLine(filePath, id);

      if (!interaction) {
        return c.json({ error: "Interaction not found" }, 404);
      }

      const userMessage = interaction.prompt.find((p) => p.role === "user");

      let prompt = "";
      if (userMessage) {
        const userContent = userMessage.content;
        if (Array.isArray(userContent)) {
          const textContent = userContent.find((m) => m.type === "text");
          if (textContent) {
            prompt = textContent.text;
          }
        } else {
          prompt = userContent;
        }
      }

      const assistantMessage = interaction.response;
      if (!assistantMessage) {
        return c.json({ error: "Assistant message not found" }, 404);
      }

      return c.json({
        prompt,
        message: assistantMessage,
      });
    } catch (_error) {
      return c.json({ error: "Failed to read interaction" }, 500);
    }
  });

export default app;
