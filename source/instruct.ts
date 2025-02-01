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
} from "@travisennis/acai-core/tools";
import envPaths from "@travisennis/stdlib/env";
import { objectEntries, objectKeys } from "@travisennis/stdlib/object";
import {
  type CoreMessage,
  type ProviderMetadata,
  type Tool,
  type UserContent,
  generateText,
  tool,
} from "ai";
import { Hono } from "hono";
import { match } from "ts-pattern";
import { z } from "zod";
import { processPrompt } from "./commands.ts";

const modes = ["normal", "research", "code", "code-interpreter"] as const;

export const app = new Hono()
  .get("/", (c) => {
    return c.json(
      {
        modes,
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
      const { model, maxTokens, temperature, system, message, mode } =
        c.req.valid("json");

      const chosenModel: ModelName = isSupportedModel(model)
        ? model
        : "anthropic:sonnet";

      const chosenMode =
        mode && modes.includes(mode as (typeof modes)[number])
          ? (mode as (typeof modes)[number])
          : "normal";

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

      const createWebSearchTools = () => {
        return {
          webSearch: tool({
            description:
              "Searches the web and returns an answer. The query can be a question or set of search terms.",
            parameters: z.object({
              query: z
                .string()
                .describe("A query or set of query terms to search for."),
            }),
            execute: async ({ query }) => {
              const { text, experimental_providerMetadata } =
                await generateText({
                  model: wrapLanguageModel(
                    languageModel("google:flash2-search"),
                    log,
                    usage,
                    auditMessage({ path: messagesFilePath }),
                  ),
                  temperature: temperature ?? 0.3,
                  maxTokens: maxTokens ?? 8192,
                  prompt: query,
                });
              const metadata = parseMetadata(experimental_providerMetadata);
              const sources = metadata.sources.map(
                (source) => `${source.title}\n${source.url}\n${source.snippet}`,
              );
              return `Answer: ${text}\n\nSources:${sources.join("\n\n")}`;
            },
          }),
        };
      };

      const webSearchTools = createWebSearchTools();

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

      //       const { text: chosenTools } = await generateText({
      //         model: languageModel("google:flash2"),
      //         system: `You task is to determine the tools that are most useful for the given task.

      // If the task is to understand a project, code base, or set of files then use the following tools:
      // ${[...objectKeys(fsTools), ...objectKeys(gitTools)].join("\n")}

      // If the task is to update or edit a project, code base, or set of files then use the following tools:
      // ${[
      //   ...objectKeys(codeTools),
      //   ...objectKeys(codeInterpreterTool),
      //   ...objectKeys(fsTools),
      //   ...objectKeys(gitTools),
      // ].join("\n")}

      // If the task is to work with bookmarks then use the following tools:
      // ${[...objectKeys(raindropTools), ...objectKeys(urlTools)].join("\n")}

      // If the task is to read content from URLs then use the following bookmarks:
      // ${[...objectKeys(urlTools)].join("\n")}

      // If the task is to search for additional information on the web then use the following tools:
      // ${[...objectKeys(webSearchTools)].join("\n")}

      // If the task is to think through problems or brainstorm ideas then use the following tools:
      // ${[...objectKeys(thinkingTools), ...objectKeys(brainstormingTools)].join("\n")}

      // Only respond with the tools that are most useful for this task. A task may require tools from multiple lists. Your response should be a comma-separated list.`,
      //         prompt: `Task: ${finalMessage}: Output:`,
      //       });

      //       console.info(chosenTools);
      //       const activeTools = chosenTools
      //         .split(",")
      //         .map((tool) => tool.trim())
      //         .filter((tool) =>
      //           objectKeys(allTools).includes(tool as keyof typeof allTools),
      //         ) as (keyof typeof allTools)[];
      //
      const activeTools = await findTools({ tools: allTools, finalMessage });

      // const activeTools: (keyof typeof allTools)[] = match(chosenMode)
      //   .with("normal", () => [])
      //   .with("research", () => [
      //     ...objectKeys(thinkingTools),
      //     ...objectKeys(brainstormingTools),
      //     ...objectKeys(raindropTools),
      //     ...objectKeys(urlTools),
      //     ...objectKeys(webSearchTools),
      //   ])
      //   .with("code", () => [
      //     ...objectKeys(codeTools),
      //     ...objectKeys(codeInterpreterTool),
      //     ...objectKeys(fsTools),
      //     ...objectKeys(gitTools),
      //   ])
      //   .with("code-interpreter", () => [...objectKeys(codeInterpreterTool)])
      //   .exhaustive();

      const systemPrompt =
        system ??
        match(chosenMode)
          .with(
            "normal",
            () =>
              "You are a very helpful assistant that is focused on helping solve hard problems.",
          )
          .with(
            "research",
            () =>
              `You are research assistant. Help me understand difficult topics. Today's date is ${(new Date()).toISOString()}`,
          )
          .with("code", () => "You are software engineering assistant.")
          .with(
            "code-interpreter",
            () =>
              "You are a very helpful assistant that is focused on helping solve hard problems.",
          )
          .exhaustive();

      const maxSteps = 15;

      const { text, reasoning, experimental_providerMetadata } =
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

async function findTools<T extends Record<string, Tool<any>>>({
  tools,
  finalMessage,
}: { tools: T; finalMessage: string }): Promise<(keyof T)[]> {
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
    prompt: `Task: ${finalMessage}: Output:`,
  });

  console.log(chosenTools);
  const activeTools = chosenTools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) =>
      objectKeys(tools).includes(tool as keyof typeof tools),
    ) as (keyof typeof tools)[];

  return activeTools;
}
