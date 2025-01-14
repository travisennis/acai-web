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
import { join } from "@travisennis/stdlib/desm";
import envPaths from "@travisennis/stdlib/env";
import { objectKeys } from "@travisennis/stdlib/object";
import {
  type CoreMessage,
  type ProviderMetadata,
  type UserContent,
  generateText,
} from "ai";
import { Hono } from "hono";
import { match } from "ts-pattern";
import { z } from "zod";
import { processPrompt } from "./commands.ts";

const modes = ["normal", "research", "code"] as const;

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

      const chosenMode =
        mode && modes.includes(mode as (typeof modes)[number])
          ? (mode as (typeof modes)[number])
          : "normal";

      const MEMORY_FILE_PATH = join(
        import.meta.url,
        "..",
        "data",
        "memory.json",
      );

      const stateDir = envPaths("acai").state;
      const MESSAGES_FILE_PATH = path.join(stateDir, "messages.jsonl");

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

      const langModel = wrapLanguageModel(
        languageModel(chosenModel),
        log,
        usage,
        auditMessage({ path: MESSAGES_FILE_PATH }),
      );

      const fsTools = await createFileSystemTools({
        workingDir: pp.projectDir ?? `${baseDir}/temp`,
      });

      const gitTools = await createGitTools({
        workingDir: pp.projectDir ?? `${baseDir}/temp`,
      });

      const codeTools = createCodeTools({
        baseDir: pp.projectDir ?? `${baseDir}/temp`,
      });

      const codeInterpreterTool = createCodeInterpreterTool({});

      const raindropTools = createRaindropTools({
        apiKey: process.env.RAINDROP_API_KEY ?? "",
      });

      const urlTools = createUrlTools();

      const memoryTools = createKnowledgeGraphTools({ path: MEMORY_FILE_PATH });

      const thinkingTools = createSequentialThinkingTool();

      const brainstormingTools = createBrainstormingTools(langModel);

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
      } as const;

      const activeTools: (keyof typeof allTools)[] = match(chosenMode)
        .with("normal", () => [])
        .with("research", () => [
          ...objectKeys(thinkingTools),
          ...objectKeys(brainstormingTools),
          ...objectKeys(raindropTools),
          ...objectKeys(urlTools),
        ])
        .with("code", () => [
          ...objectKeys(codeTools),
          ...objectKeys(codeInterpreterTool),
          ...objectKeys(fsTools),
          ...objectKeys(gitTools),
        ])
        .exhaustive();

      const systemPrompt = match(chosenMode)
        .with(
          "normal",
          () =>
            "You are a very helpful assistant that is focused on helping solve hard problems.",
        )
        .with(
          "research",
          () =>
            "You are research assistant. Help me understand difficult topics.",
        )
        .with("code", () => "You are software engineering assistant.")
        .exhaustive();

      const maxSteps = match(chosenMode)
        .with("normal", () => 3)
        .with("research", () => 10)
        .with("code", () => 15)
        .exhaustive();

      const { text, experimental_providerMetadata } = await generateText({
        model: wrapLanguageModel(
          languageModel(chosenModel),
          log,
          usage,
          auditMessage({ path: MESSAGES_FILE_PATH }),
        ),
        temperature: temperature ?? 0.3,
        maxTokens: maxTokens ?? 8192,
        tools: allTools,
        experimental_activeTools: activeTools,
        system: systemPrompt,
        messages,
        maxSteps,
      });

      // access the grounding metadata. Casting to the provider metadata type
      // is optional but provides autocomplete and type safety.
      const metadata = parseMetadata(experimental_providerMetadata);

      const result = `${message}\n\n${text}`;

      return c.json(
        {
          content: result.trim(),
          sources: metadata.sources,
        },
        200,
      );
    },
  );

export default app;

function parseMetadata(
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
