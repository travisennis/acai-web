import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/acai-core";
import { auditMessage } from "@travisennis/acai-core/middleware";
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
import { zip } from "@travisennis/itertools";
import envPaths from "@travisennis/stdlib/env";
import { objectKeys } from "@travisennis/stdlib/object";
import { type CoreMessage, type UserContent, generateText } from "ai";
import { Hono } from "hono";
import { match } from "ts-pattern";
import { z } from "zod";
// import { chooseActiveTools } from "./chooseActiveTools.ts";
import { processPrompt } from "./commands.ts";
import { Interaction, type InteractionInterface } from "./database.ts";
import { parseMetadata } from "./parseMetadata.ts";

const modes = ["normal", "research", "code", "brainstorm"] as const;
type Mode = (typeof modes)[number];

export const app = new Hono()
  .get("/", (c) => {
    return c.json(
      {
        modes: modes,
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

      const chosenMode: Mode =
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
        // usage,
        // log,
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
        model: wrapLanguageModel(
          languageModel("google:flash2-search"),
          // log,
          // usage,
          auditMessage({ path: messagesFilePath }),
        ),
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

      // const activeTools = await chooseActiveTools({
      //   tools: allTools,
      //   message: finalMessage,
      // });

      const activeTools: (keyof typeof allTools)[] = match(chosenMode)
        .with("normal", () => [])
        .with("research", () => [
          ...objectKeys(codeInterpreterTool),
          ...objectKeys(thinkingTools),
          ...objectKeys(raindropTools),
          ...objectKeys(urlTools),
          ...objectKeys(webSearchTools),
        ])
        .with("code", () => [
          ...objectKeys(codeTools),
          ...objectKeys(codeInterpreterTool),
          ...objectKeys(fsTools),
          ...objectKeys(gitTools),
        ])
        .with("brainstorm", () => [...objectKeys(brainstormingTools)])
        .exhaustive();

      const systemPrompt =
        system ??
        "You are a very helpful assistant that is focused on helping solve hard problems.";

      // #TODO: figure out how to adjust this based on query
      const maxSteps = 20;

      const start = performance.now();
      const {
        text,
        reasoning,
        response,
        steps,
        experimental_providerMetadata,
        usage,
      } = await generateText({
        model: langModel,
        temperature: temperature ?? 0.3,
        maxTokens: maxTokens ?? 8192,
        tools: allTools,
        // biome-ignore lint/style/useNamingConvention: <external api>
        experimental_activeTools: activeTools,
        system: systemPrompt,
        messages,
        maxSteps,
      });

      console.info(`Steps: ${steps.length}`);
      const textSteps = steps.map((step) => step.text);
      const toolCalls = steps.flatMap((step) => step.toolCalls);
      const toolResults = steps.flatMap((step) => step.toolResults);

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
        app: "acai-instruct",
        duration: performance.now() - start,
      };

      const interaction = new Interaction(i);
      await interaction.save();

      // access the grounding metadata. Casting to the provider metadata type
      // is optional but provides autocomplete and type safety.
      const metadata = parseMetadata(experimental_providerMetadata);
      console.dir(experimental_providerMetadata);

      const t = zip(toolCalls, toolResults);
      const toolOutput = t
        .map(
          (r, i) =>
            `Step ${i}:\n${textSteps[i]}\n\nToolname: ${r[0].toolName}:\nArgs: ${JSON.stringify(r[0].args)}\nResult:\n${r[1].result}`,
        )
        .toArray()
        .join("\n\n");
      const thinkingBlock = `<think>\n${reasoning}\n</think>\n\n`;
      const result = `${message}\n\n${reasoning ? thinkingBlock : ""}${toolOutput}\n===\n\n${text}`;

      return c.json(
        {
          content: result.trim(),
          sources: metadata.sources,
        },
        200,
      );
    },
  );
