import { randomUUID } from "node:crypto";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { createBrainstormingTools } from "@travisennis/acai-brainstorm";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
} from "@travisennis/acai-core";
import {
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
import { envPaths } from "@travisennis/stdlib/env";
import { objectKeys } from "@travisennis/stdlib/object";
import {
  type CoreMessage,
  NoSuchToolError,
  type UserContent,
  generateObject,
  streamText,
} from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { match } from "ts-pattern";
import { z } from "zod";
// import { chooseActiveTools } from "./chooseActiveTools.ts";
import { processPrompt } from "./commands.ts";
import { Interaction, type InteractionInterface } from "./database.ts";
import { parseMetadata } from "./parseMetadata.ts";

const modes = ["normal", "research", "code", "brainstorm"] as const;
type Mode = (typeof modes)[number];

const requestSchema = z.object({
  model: z.string().optional(),
  temperature: z.coerce.number().optional(),
  maxTokens: z.coerce.number().optional(),
  system: z.string().optional(),
  message: z.string(),
  mode: z.enum(modes).optional(),
});

type RequestType = z.infer<typeof requestSchema>;

const streams = new Map<string, RequestType>();

export const app = new Hono()
  .get("/config", (c) => {
    return c.json(
      {
        modes: modes,
      },
      200,
    );
  })
  .post("/", zValidator("json", requestSchema), (c) => {
    const data = c.req.valid("json");
    const uuid = randomUUID();
    streams.set(uuid, data);
    return c.json({
      requestId: uuid,
    });
  })
  .get(
    "/",
    zValidator(
      "query",
      z.object({
        requestId: z.string(),
      }),
    ),
    (c) => {
      return streamSSE(c, async (stream) => {
        // Implement connection timeout
        const timeout = setTimeout(
          () => {
            stream.close();
          },
          30 * 60 * 1000,
        ); // 30 minutes

        // Cleanup on client disconnect
        c.req.raw.signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          stream.close();
        });

        const { requestId } = c.req.valid("query");
        const requestBody = streams.get(requestId);
        if (!requestBody) {
          await stream.writeSSE({
            event: "error",
            data: "Invalid request id.",
          });
          return;
        }

        const { model, maxTokens, temperature, system, message, mode } =
          requestBody;

        streams.delete(requestId);

        const chosenModel: ModelName = isSupportedModel(model)
          ? model
          : "anthropic:sonnet";

        const chosenMode: Mode =
          mode && modes.includes(mode as (typeof modes)[number])
            ? (mode as (typeof modes)[number])
            : "normal";

        const dataDir = envPaths("acai").data;
        const memoryFilePath = path.join(dataDir, "memory.json");

        const baseDir = process.env.BASE_DIR;
        if (!baseDir) {
          await stream.writeSSE({
            event: "error",
            data: "Base directory is not set.",
          });
          return;
        }

        const pp = await processPrompt(message, {
          baseDir,
          model: chosenModel,
        });

        if (pp.returnPrompt) {
          await stream.writeSSE({
            event: "update-prompt",
            data: pp.processedPrompt,
          });
          return;
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

        const langModel = languageModel(chosenModel);

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

        const urlTools = createUrlTools({
          summarizationModel: languageModel("anthropic:haiku"),
        });

        const memoryTools = createKnowledgeGraphTools({ path: memoryFilePath });

        const thinkingTools = createSequentialThinkingTool();

        const brainstormingTools = createBrainstormingTools(langModel);

        const webSearchTools = createWebSearchTools({
          model: languageModel("google:flash2-search"),
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
        const maxSteps = 30;

        const start = performance.now();
        const result = streamText({
          model: langModel,
          temperature: temperature ?? 0.3,
          maxTokens: maxTokens ?? 8192,
          tools: allTools,
          // biome-ignore lint/style/useNamingConvention: <external api>
          experimental_activeTools: activeTools,
          system: systemPrompt,
          messages,
          maxSteps,
          // biome-ignore lint/style/useNamingConvention: <explanation>
          experimental_repairToolCall: async ({
            toolCall,
            tools,
            parameterSchema,
            error,
          }) => {
            if (NoSuchToolError.isInstance(error)) {
              return null; // do not attempt to fix invalid tool names
            }

            const tool = tools[toolCall.toolName as keyof typeof tools];

            const { object: repairedArgs } = await generateObject({
              model: languageModel("openai:gpt-4o-structured"),
              schema: tool.parameters,
              prompt: [
                `The model tried to call the tool "${toolCall.toolName}" with the following arguments:`,
                JSON.stringify(toolCall.args),
                "The tool accepts the following schema:",
                JSON.stringify(parameterSchema(toolCall)),
                "Please fix the arguments.",
              ].join("\n"),
            });

            return { ...toolCall, args: JSON.stringify(repairedArgs) };
          },
          onStepFinish: async (event) => {
            if (
              event.stepType === "initial" &&
              event.toolCalls.length > 0 &&
              event.text.length > 0
            ) {
              await stream.writeSSE({
                event: "message",
                data: `\nStep: ${event.text}\n`,
              });
            }
          },
          onFinish: async (result) => {
            console.info(`Steps: ${result.steps.length}`);
            // const textSteps = result.steps.map((step) => step.text);
            // const toolCalls = result.steps.flatMap((step) => step.toolCalls);
            // const toolResults = result.steps.flatMap(
            //   (step) => step.toolResults,
            // );

            // remove file data. need to reduce storage costs
            const cleanedMessages = messages.map((msg) => {
              if (msg.role === "user") {
                const content = msg.content;
                if (Array.isArray(content)) {
                  msg.content = content.map((c) => {
                    if (c.type === "file") {
                      c.data = "...";
                      return c;
                    }
                    return c;
                  });
                }
                return msg;
              }
              return msg;
            });

            const i: Omit<InteractionInterface, "timestamp"> = {
              model: result.response.modelId,
              params: {
                temperature: temperature ?? 0.3,
                maxTokens: maxTokens ?? 8192,
                activeTools,
              },
              messages: cleanedMessages.concat(result.response.messages),
              usage: {
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
              },
              app: "acai-instruct",
              duration: performance.now() - start,
            };

            const interaction = new Interaction(i);
            await interaction.save();

            // access the grounding metadata. Casting to the provider metadata type
            // is optional but provides autocomplete and type safety.
            console.dir(result.providerMetadata);
            const metadata = parseMetadata(result.providerMetadata);
            console.dir(metadata);

            // console.info(result.reasoning);

            await stream.writeSSE({
              event: "close",
              data: "request finished",
            });
          },
          onError: async ({ error }) => {
            console.error(error);

            await stream.writeSSE({
              event: "close",
              data: `request error: ${(error as Error).message}`,
            });
          },
        });

        let lastType: "reasoning" | "text-delta" | null = null;
        for await (const chunk of result.fullStream) {
          if (chunk.type === "reasoning" || chunk.type === "text-delta") {
            if (lastType !== "reasoning" && chunk.type === "reasoning") {
              await stream.writeSSE({
                event: "message",
                data: "\n<think>\n",
              });
            } else if (lastType === "reasoning" && chunk.type !== "reasoning") {
              await stream.writeSSE({
                event: "message",
                data: "\n</think>\n",
              });
            }
            await stream.writeSSE({
              event: "message",
              data: chunk.textDelta,
            });
            lastType = chunk.type;
          }
        }
        if (lastType === "reasoning") {
          await stream.writeSSE({
            event: "message",
            data: "\n</think>\n",
          });
        }

        result.consumeStream();
      });
    },
  );
