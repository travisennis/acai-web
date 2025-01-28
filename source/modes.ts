import path from "node:path";
import { openai } from "@ai-sdk/openai";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/acai-core";
import { auditMessage, log, usage } from "@travisennis/acai-core/middleware";
import {
  bon,
  cot,
  echo,
  leap,
  mcts,
  moa,
  plansearch,
  pvg,
  reread,
  roundTripOptimization,
  selfConsistency,
  tot,
} from "@travisennis/acai-core/optim";
import envPaths from "@travisennis/stdlib/env";
import { generateText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { processPrompt } from "./commands.ts";

export const app = new Hono().post(
  "/",
  zValidator(
    "json",
    z.object({
      model: z.string().optional(),
      temperature: z.coerce.number().optional(),
      maxTokens: z.coerce.number().optional(),
      message: z.string(),
      mode: z.string().optional(),
    }),
  ),
  async (c) => {
    const { model, maxTokens, temperature, message, mode } =
      c.req.valid("json");

    const chosenModel: ModelName = isSupportedModel(model)
      ? model
      : "anthropic:sonnet";

    const chosenMode = mode;

    // Define the path to the JSONL file, you can change this to your desired local path
    const stateDir = envPaths("acai").state;
    const messagesFilePath = path.join(stateDir, "messages.jsonl");

    const baseDir = "/Users/travisennis/Github";
    const pp = await processPrompt(message, {
      baseDir,
    });

    if (pp.returnPrompt) {
      return c.json(
        {
          content: pp.processedPrompt,
        },
        200,
      );
    }

    const finalMessage = pp.processedPrompt;

    const langModel = wrapLanguageModel(
      languageModel(chosenModel),
      log,
      usage,
      auditMessage({ path: messagesFilePath }),
    );

    let finalResponse = "";
    if (chosenMode === "normal") {
      const { text } = await generateText({
        model: langModel,
        temperature: temperature ?? 0.3,
        maxTokens: maxTokens ?? 8192,
        prompt: finalMessage,
      });
      finalResponse = text;
    } else if (chosenMode === "bon") {
      const result = await bon({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "cot") {
      const result = await cot({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "echo") {
      const result = await echo({
        model: langModel,
        prompt: finalMessage,
        embeddingModel: openai.embedding("text-embedding-3-small"),
      });
      finalResponse = result[0];
    } else if (chosenMode === "leap") {
      const result = await leap({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "mcts") {
      const result = await mcts({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "moa") {
      const result = await moa({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "plansearch") {
      const result = await plansearch({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "pvg") {
      const result = await pvg({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "reread") {
      const result = await reread({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "rto") {
      const result = await roundTripOptimization({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "self-consistency") {
      const result = await selfConsistency({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    } else if (chosenMode === "tot") {
      const result = await tot({
        model: langModel,
        prompt: finalMessage,
      });
      finalResponse = result[0];
    }

    const result = `${message}\n\n${finalResponse}`;

    return c.json(
      {
        content: result.trim(),
      },
      200,
    );
  },
);

export default app;
