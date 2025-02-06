import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { Prompt } from "./database.ts";

export const app = new Hono();

// Define the prompt schemas with role field
const promptSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  role: z.enum(["system", "user"]).optional(),
});

const updatePromptSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string(),
  role: z.enum(["system", "user"]).optional(),
});

// Helper functions
async function getAllPrompts() {
  return await Prompt.find().sort({ createdAt: -1 });
}

async function getPrompt(id: string) {
  return await Prompt.findById(id);
}

// Routes
app
  .post("/", zValidator("json", promptSchema), async (c) => {
    try {
      const { name, content, role } = c.req.valid("json");

      const prompt = await Prompt.create({
        name,
        content,
        role: role ?? "user",
      });

      return c.json(prompt, 201);
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
    } catch (error) {
      return c.json(
        { error: `Failed to retrieve prompts: ${(error as Error).message}` },
        500,
      );
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
    } catch (error) {
      return c.json(
        { error: `Failed to retrieve prompt: ${(error as Error).message}` },
        500,
      );
    }
  })
  .put("/:id", zValidator("json", updatePromptSchema), async (c) => {
    try {
      const id = c.req.param("id");
      const updateData = c.req.valid("json");

      const updatedPrompt = await Prompt.findByIdAndUpdate(
        id,
        { $set: updateData },
        { new: true },
      );

      if (!updatedPrompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      return c.json(updatedPrompt);
    } catch (error) {
      return c.json(
        { error: `Failed to update prompt: ${(error as Error).message}` },
        500,
      );
    }
  })
  .delete("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const deletedPrompt = await Prompt.findByIdAndDelete(id);

      if (!deletedPrompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      return c.json({ message: "Prompt deleted successfully" });
    } catch (error) {
      return c.json(
        { error: `Failed to delete prompt: ${(error as Error).message}` },
        500,
      );
    }
  });
