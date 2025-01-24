import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import type { UserContent } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import envPaths from "@travisennis/stdlib/env";

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

async function getHistoryFiles(stateDir: string): Promise<string[]> {
  const files: string[] = [];
  const baseFile = path.join(stateDir, "messages.jsonl");

  if (existsSync(baseFile)) {
    files.push(baseFile);
  }

  // Find all rolled over files (messages-N.jsonl)
  const dirEntries = await fs.readdir(stateDir);
  const rolledFiles = dirEntries
    .filter((file) => /^messages-\d+\.jsonl$/.test(file))
    .sort((a, b) => {
      const numA = Number.parseInt(
        a.match(/messages-(\d+)\.jsonl/)?.[1] || "0",
      );
      const numB = Number.parseInt(
        b.match(/messages-(\d+)\.jsonl/)?.[1] || "0",
      );
      return numB - numA; // Sort in descending order (newest first)
    })
    .map((file) => path.join(stateDir, file));

  return [...files, ...rolledFiles];
}

async function readLines(files: string[]): Promise<string[]> {
  const allLines: string[] = [];

  // Read all files and combine their lines
  for (const file of files) {
    if (existsSync(file)) {
      const content = await fs.readFile(file, "utf-8");
      allLines.push(...content.trim().split("\n").reverse());
    }
  }

  return allLines;
}

async function readPaginatedLines(
  allLines: string[],
  page: number,
  pageSize: number,
): Promise<Interaction[]> {
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, allLines.length);
  const selectedLines = allLines.slice(startIndex, endIndex);

  return selectedLines.map((line, index) => ({
    ...JSON.parse(line),
    id: startIndex + index + 1,
  }));
}

function readSpecificLine(lines: string[], lineNumber: number): Interaction {
  const line = lines.at(lineNumber - 1);
  const interaction = line ? JSON.parse(line) : "Not found.";
  return {
    ...interaction,
    id: lineNumber,
  };
}

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(10),
});

app
  .get("/", zValidator("query", querySchema), async (c) => {
    try {
      const { page, pageSize } = c.req.valid("query");
      const stateDir = envPaths("acai").state;

      const files = await getHistoryFiles(stateDir);

      const lines = await readLines(files);

      const totalItems = lines.length;
      const totalPages = Math.ceil(totalItems / pageSize);

      const interactions = await readPaginatedLines(lines, page, pageSize);

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

      const stateDir = envPaths("acai").state;

      const files = await getHistoryFiles(stateDir);

      const lines = await readLines(files);

      const interaction = readSpecificLine(lines, id);

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
