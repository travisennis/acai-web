import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/acai-core";
import { auditMessage, log } from "@travisennis/acai-core/middleware";
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
import { type CoreMessage, generateText } from "ai";
import { type Env, Hono } from "hono";
import { z } from "zod";
import { chooseActiveTools } from "./chooseActiveTools.ts";
import { processPrompt } from "./commands.ts";
import { Interaction, type InteractionInterface } from "./database.ts";
import { parseMetadata } from "./parseMetadata.ts";

const messages: CoreMessage[] = [];

export const app = new Hono<Env>();

app.post(
  "/",
  zValidator(
    "json",
    z.object({
      model: z.string().optional(),
      maxTokens: z.coerce.number().optional(),
      temperature: z.coerce.number().optional(),
      system: z.string().optional(),
      message: z.string(),
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

    messages.push({
      role: "user",
      content: pp.processedPrompt,
    });

    const langModel = wrapLanguageModel(
      languageModel(chosenModel),
      log,
      auditMessage({ path: messagesFilePath }),
    );

    const fsTools = await createFileSystemTools({
      workingDir: baseDir,
    });

    const gitTools = await createGitTools({
      workingDir: baseDir,
    });

    const codeTools = createCodeTools({
      baseDir,
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
      message,
    });

    const systemPrompt =
      system ??
      "You are a very helpful assistant that is focused on helping solve hard problems.";
    const maxSteps = 15;

    const start = performance.now();
    const {
      text,
      response,
      reasoning,
      toolCalls,
      usage,
      experimental_providerMetadata,
    } = await generateText({
      model: langModel,
      temperature: temperature ?? 0.3,
      maxTokens: maxTokens ?? 8192,
      tools: allTools,
      // biome-ignore lint/style/useNamingConvention: <explanation>
      experimental_activeTools: activeTools,
      system: systemPrompt,
      messages,
      maxSteps,
    });

    const i: Omit<InteractionInterface, "timestamp"> = {
      model: response.modelId,
      params: {
        temperature: temperature ?? 0.3,
        maxTokens: maxTokens ?? 8192,
        activeTools,
      },
      messages: messages.concat(response.messages),
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
      app: "acai-chat",
      duration: performance.now() - start,
    };

    const interaction = new Interaction(i);
    await interaction.save();

    messages.push(...response.messages);

    console.info(`Active tools: ${activeTools.join(", ")}`);
    console.info(`Tools called: ${toolCalls.length}`);
    console.info(
      `Tools: ${toolCalls.map((toolCall) => toolCall.toolName).join(", ")}`,
    );

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
