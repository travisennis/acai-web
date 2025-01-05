import path from "node:path";
import { fileURLToPath } from "node:url";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/ai-sdk-ext";
import { auditMessage, log, usage } from "@travisennis/ai-sdk-ext/middleware";
import {
  createCodeInterpreterTool,
  createFileSystemTools,
  createGitTools,
  createKnowledgeGraphTools,
  createRaindropTools,
  createSequentialThinkingTool,
  createUrlTools,
} from "@travisennis/ai-sdk-ext/tools";
import { type CoreMessage, type UserContent, generateText } from "ai";
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

    // Define the path to the JSONL file, you can change this to your desired local path
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const MEMORY_FILE_PATH = path.join(__dirname, "..", "data", "memory.json");
    const MESSAGES_FILE_PATH = path.join(
      __dirname,
      "..",
      "data",
      "messages.jsonl",
    );

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
    const messages: CoreMessage[] = [];
    if (pp.attachments.length > 0) {
      const content: UserContent = [
        {
          type: "text",
          text: finalMessage,
        },
      ];

      for (const attachment of pp.attachments) {
        content.push({
          type: "file",
          data: attachment,
          mimeType: "application/pdf",
        });
      }

      messages.push({
        role: "user",
        content,
      });
    } else {
      messages.push({
        role: "user",
        content: finalMessage,
      });
    }

    const fsTools = await createFileSystemTools({
      workingDir: pp.projectDir ?? `${baseDir}/temp`,
    });

    const gitTools = await createGitTools({
      workingDir: pp.projectDir ?? `${baseDir}/temp`,
    });

    const codeInterpreterTool = createCodeInterpreterTool({});

    const raindropTools = createRaindropTools({
      apiKey: process.env.RAINDROP_API_KEY ?? "",
    });

    const urlTools = createUrlTools();

    const memoryTools = createKnowledgeGraphTools({ path: MEMORY_FILE_PATH });

    const thinkingTools = createSequentialThinkingTool();

    const allTools = {
      ...fsTools,
      ...gitTools,
      ...codeInterpreterTool,
      ...raindropTools,
      ...urlTools,
      ...memoryTools,
      ...thinkingTools,
    };

    const { text } = await generateText({
      model: wrapLanguageModel(
        languageModel(chosenModel),
        log,
        usage,
        auditMessage({ path: MESSAGES_FILE_PATH }),
      ),
      temperature: temperature ?? 0.3,
      maxTokens: maxTokens ?? 8192,
      tools: allTools,
      experimental_activeTools: [...objectKeys(fsTools)],
      system:
        "You are a very helpful assistant that is focused on helping solve hard problems.",
      messages,
      maxSteps: 10,
    });

    const result = `${message}\n\n${text}`;

    return c.json(
      {
        content: result.trim(),
      },
      200,
    );
  },
);

function objectKeys<T extends object>(obj: T): Array<keyof T> {
  return Object.keys(obj) as Array<keyof T>;
}

export default app;
