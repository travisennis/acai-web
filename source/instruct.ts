import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/acai-core";
import { auditMessage, log, usage } from "@travisennis/acai-core/middleware";
import {
  createBrainstormingTools,
  createCodeInterpreterTool,
  createCodeTools,
  createFileSystemTools,
  createGitTools,
  createKnowledgeGraphTools,
  createRaindropTools,
  createSequentialThinkingTool,
  createUrlTools,
  createWebSearchTools,
} from "@travisennis/acai-core/tools";
import envPaths from "@travisennis/stdlib/env";
import { type CoreMessage, type UserContent, generateText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { chooseActiveTools } from "./chooseActiveTools.ts";
import { processPrompt } from "./commands.ts";
import { parseMetadata } from "./parseMetadata.ts";

export const app = new Hono()
  .get("/", (c) => {
    return c.json(
      {
        modes: [],
      },
      200,
    );
  })
  .post(
    "/",
    zValidator(
      "json",
      z.object({
        model: z.string().optional(),
        temperature: z.coerce.number().optional(),
        maxTokens: z.coerce.number().optional(),
        system: z.string().optional(),
        message: z.string(),
        mode: z.string().optional(),
      }),
    ),
    async (c) => {
      const { model, maxTokens, temperature, system, message } =
        c.req.valid("json");

      const chosenModel: ModelName = isSupportedModel(model)
        ? model
        : "anthropic:sonnet";

      const dataDir = envPaths("acai").data;
      const memoryFilePath = path.join(dataDir, "memory.json");

      const stateDir = envPaths("acai").state;
      const messagesFilePath = path.join(stateDir, "messages.jsonl");

      const baseDir = process.env.BASE_DIR;
      if (!baseDir) {
        return c.json(
          {
            message: "Base directory is not set.",
          },
          500,
        );
      }

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

      const langModel = wrapLanguageModel(
        languageModel(chosenModel),
        log,
        usage,
        auditMessage({ path: messagesFilePath }),
      );

      const fsTools = await createFileSystemTools({
        workingDir: pp.projectDir ?? baseDir,
      });

      const gitTools = await createGitTools({
        workingDir: pp.projectDir ?? baseDir,
      });

      const codeTools = createCodeTools({
        baseDir: pp.projectDir ?? baseDir,
      });

      const codeInterpreterTool = createCodeInterpreterTool({});

      const raindropTools = createRaindropTools({
        apiKey: process.env.RAINDROP_API_KEY ?? "",
      });

      const urlTools = createUrlTools();

      const memoryTools = createKnowledgeGraphTools({ path: memoryFilePath });

      const thinkingTools = createSequentialThinkingTool();

      const brainstormingTools = createBrainstormingTools(langModel);

      const webSearchTools = createWebSearchTools({
        auditPath: messagesFilePath,
      });

      const allTools = {
        ...codeTools,
        ...fsTools,
        ...gitTools,
        ...codeInterpreterTool,
        ...raindropTools,
        ...urlTools,
        ...memoryTools,
        ...thinkingTools,
        ...brainstormingTools,
        ...webSearchTools,
      } as const;

      const activeTools = await chooseActiveTools({
        tools: allTools,
        message: finalMessage,
      });

      const systemPrompt =
        system ??
        "You are a very helpful assistant that is focused on helping solve hard problems.";

      // #TODO: figure out how to adjust this based on query
      const maxSteps = 15;

      const {
        text,
        reasoning,
        toolCalls,
        toolResults,
        experimental_providerMetadata,
      } = await generateText({
        model: wrapLanguageModel(
          languageModel(chosenModel),
          log,
          usage,
          auditMessage({ path: messagesFilePath }),
        ),
        temperature: temperature ?? 0.3,
        maxTokens: maxTokens ?? 8192,
        tools: allTools,
        // biome-ignore lint/style/useNamingConvention: <external api>
        experimental_activeTools: activeTools,
        system: systemPrompt,
        messages,
        maxSteps,
      });

      console.dir(toolCalls);
      console.dir(toolResults);

      console.info(`Active tools: ${activeTools.join(", ")}`);
      console.info(`Tools called: ${toolCalls.length}`);
      console.info(
        `Tools: ${toolCalls.map((toolCall) => toolCall.toolName).join(", ")}`,
      );

      // access the grounding metadata. Casting to the provider metadata type
      // is optional but provides autocomplete and type safety.
      const metadata = parseMetadata(experimental_providerMetadata);

      const thinkingBlock = `<think>\n${reasoning}\n</think>\n\n`;
      const result = `${message}\n\n${reasoning ? thinkingBlock : ""}${text}`;

      return c.json(
        {
          content: result.trim(),
          sources: metadata.sources,
        },
        200,
      );
    },
  );
