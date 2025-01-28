import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/acai-core";
import { auditMessage, log, usage } from "@travisennis/acai-core/middleware";
import envPaths from "@travisennis/stdlib/env";
import { type CoreMessage, generateText } from "ai";
import { type Env, Hono } from "hono";
import { z } from "zod";

const app = new Hono<Env>();

const messages: CoreMessage[] = [];

app.post(
  "/",
  zValidator(
    "json",
    z.object({
      model: z.string().optional(),
      maxTokens: z.coerce.number().optional(),
      temperature: z.coerce.number().optional(),
      message: z.string(),
    }),
  ),
  async (c) => {
    const { model, maxTokens, temperature, message } = c.req.valid("json");

    const chosenModel: ModelName = isSupportedModel(model)
      ? model
      : "anthropic:sonnet";

    const stateDir = envPaths("acai").state;
    const messagesFilePath = path.join(stateDir, "messages.jsonl");

    messages.push({
      role: "user",
      content: message,
    });

    const { text } = await generateText({
      model: wrapLanguageModel(
        languageModel(chosenModel),
        log,
        usage,
        auditMessage({ path: messagesFilePath }),
      ),
      temperature: temperature ?? 0.3,
      maxTokens: maxTokens ?? 8192,
      system:
        "You are a very helpful assistant that is focused on helping solve hard problems.",
      messages: messages,
    });

    messages.push({
      role: "assistant",
      content: text,
    });

    return c.json(
      {
        content: text.trim(),
      },
      200,
    );
  },
);

export default app;
