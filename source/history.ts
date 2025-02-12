import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Interaction } from "./database";
import type { CoreMessage } from "ai";

export const app = new Hono();

interface PaginatedResult {
  interactions: {
    id: string;
    preview: string;
  }[];
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalItems: number;
  };
}

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(10),
});

function getLastAssistantMessage(messages: CoreMessage[]): string {
  const assistantMessages = messages
    .filter((msg) => msg.role === "assistant")
    .reverse();
  
  if (assistantMessages.length === 0) return "No response";
  
  const content = assistantMessages[0].content;
  if (typeof content === "string") {
    return content;
  }
  return "Complex response";
}

function extractUserPrompt(messages: CoreMessage[]): string {
  const userMessages = messages.filter((msg) => msg.role === "user");
  if (userMessages.length === 0) return "";

  const content = userMessages[0].content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textContent = content.find((m) => m.type === "text");
    return textContent ? textContent.text : "";
  }
  return "";
}

app
  .get("/", zValidator("query", querySchema), async (c) => {
    try {
      const { page, pageSize } = c.req.valid("query");
      const skip = (page - 1) * pageSize;

      // Get total count for pagination
      const totalItems = await Interaction.countDocuments();
      const totalPages = Math.ceil(totalItems / pageSize);

      // Fetch paginated interactions
      const interactions = await Interaction.find()
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean();

      const formattedInteractions = interactions.map((interaction) => {
        const preview = getLastAssistantMessage(interaction.messages);
        return {
          id: interaction._id.toString(),
          preview: preview.substring(0, 100) + (preview.length > 100 ? "..." : ""),
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
    } catch (error) {
      console.error("Failed to read history:", error);
      return c.json({ error: "Failed to read history" }, 500);
    }
  })
  .get("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      
      const interaction = await Interaction.findById(id).lean();

      if (!interaction) {
        return c.json({ error: "Interaction not found" }, 404);
      }

      const prompt = extractUserPrompt(interaction.messages);
      const message = getLastAssistantMessage(interaction.messages);

      return c.json({
        prompt,
        message,
      });
    } catch (error) {
      console.error("Failed to read interaction:", error);
      return c.json({ error: "Failed to read interaction" }, 500);
    }
  });