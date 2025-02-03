import path from "node:path";
import type { GoogleGenerativeAIProviderMetadata } from "@ai-sdk/google";
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
import { objectEntries, objectKeys } from "@travisennis/stdlib/object";
import {
  type CoreMessage,
  type ProviderMetadata,
  type Tool,
  type UserContent,
  generateText,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { processPrompt } from "./commands.ts";

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

      const { text, reasoning, toolCalls, experimental_providerMetadata } =
        await generateText({
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

function parseMetadata(
  // biome-ignore lint/style/useNamingConvention: <third-party api>
  experimental_providerMetadata: ProviderMetadata | undefined,
) {
  const metadata = experimental_providerMetadata?.google as
    | GoogleGenerativeAIProviderMetadata
    | undefined;

  // Extract sources from grounding metadata
  const sourceMap = new Map<
    string,
    { title: string; url: string; snippet: string }
  >();

  // Get grounding metadata from response
  const chunks = metadata?.groundingMetadata?.groundingChunks || [];
  const supports = metadata?.groundingMetadata?.groundingSupports || [];

  chunks.forEach((chunk, index: number) => {
    if (chunk.web?.uri && chunk.web?.title) {
      const url = chunk.web.uri;
      if (!sourceMap.has(url)) {
        // Find snippets that reference this chunk
        const snippets = supports
          .filter((support) => support.groundingChunkIndices?.includes(index))
          .map((support) => support.segment.text)
          .join(" ");

        sourceMap.set(url, {
          title: chunk.web.title,
          url: url,
          snippet: snippets || "",
        });
      }
    }
  });

  const sources = Array.from(sourceMap.values());

  return {
    sources,
  };
}

async function chooseActiveTools<T extends Record<string, Tool>>({
  tools,
  message,
}: { tools: T; message: string }): Promise<(keyof T)[]> {
  const toolDescriptions = objectEntries(tools).map(
    (tool) =>
      `Name: ${tool[0] as string}\nDescription: ${(tool[1] as { description: string }).description}`,
  );

  const system = `You task is to determine the tools that are most useful for the given task.

Here are the tools available:
${toolDescriptions.join("\n\n")}

Only respond with the tools that are most useful for this task. Your response should be a comma-separated list of the tool names.`;

  console.log(system);

  const { text: chosenTools } = await generateText({
    model: languageModel("google:flash2"),
    system,
    prompt: `Task: ${message}: Output:`,
  });

  const activeTools = chosenTools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) =>
      objectKeys(tools).includes(tool as keyof typeof tools),
    ) as (keyof typeof tools)[];

  return activeTools;
}
