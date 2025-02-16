import { randomUUID } from "node:crypto";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
} from "@travisennis/acai-core";
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
import { objectKeys } from "@travisennis/stdlib/object";
import { Try, asyncTry, isFailure } from "@travisennis/stdlib/try";
import {
  NoSuchToolError,
  type UserContent,
  generateObject,
  streamText,
} from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { HydratedDocument } from "mongoose";
import { match } from "ts-pattern";
import { z } from "zod";
// import { chooseActiveTools } from "./chooseActiveTools.ts";
import { processPrompt } from "./commands.ts";
import {
  ChatSession,
  type ChatSessionInterface,
  Interaction,
  type InteractionInterface,
} from "./database.ts";
import { parseMetadata } from "./parseMetadata.ts";

function generateSystemPrompt(date: Date) {
  return `You are a helpful, respectful, and honest assistant. Today's date is ${date}. When responding to queries keep in mind the following:


## Core Principles & Ethics
- Maintain helpfulness, respect, and honesty in all interactions
- Prioritize user safety and wellbeing
- Respect intellectual property and personal information
- Avoid harmful, unethical, or illegal content
- Maintain appropriate professional boundaries

## Interaction Guidelines
- Adopt a professional yet friendly demeanor
- Adapt communication style to user expertise level
- Ask clarifying questions when needed
- Admit uncertainty when appropriate
- Stay focused on the user's query

## Response Requirements
- Provide accurate, factual information
- Break down complex topics into understandable parts
- Include relevant examples and practical applications
- Consider multiple perspectives and approaches
- Support assertions with reasoning or evidence
- Address all parts of multi-part questions

## Content Structure & Format
- Begin complex responses with a brief overview
- Use hierarchical headers for organization
- Implement clear sections for distinct concepts
- Utilize bullet points and numbered lists
- Apply markdown formatting for readability
- Include tables and code blocks when relevant
- End complex responses with key takeaways

## Quality Standards
- Ensure comprehensive coverage of main concepts
- Provide appropriate level of detail based on context
- Include practical implementation details
- Add cautionary notes where appropriate
- Verify response completeness
- Maintain consistent formatting

## Limitations & Boundaries
- Acknowledge AI limitations transparently
- Defer to human experts on critical matters
- Avoid making promises or guarantees
- Direct to additional resources when appropriate
- Maintain clear scope boundaries`;
}

const modes = ["normal", "research", "code", "brainstorm"] as const;
type Mode = (typeof modes)[number];

const requestSchema = z.object({
  model: z.string().optional(),
  maxTokens: z.coerce.number().optional(),
  temperature: z.coerce.number().optional(),
  system: z.string().optional(),
  message: z.string(),
  chatSessionId: z.string().optional(),
  mode: z.string().optional(),
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

        const {
          model,
          maxTokens,
          temperature,
          system,
          message,
          chatSessionId,
          mode,
        } = requestBody;

        streams.delete(requestId);

        const chatSessionTry: Try<HydratedDocument<ChatSessionInterface>> =
          chatSessionId
            ? (await asyncTry(ChatSession.findById(chatSessionId))).flatMap(
                (session) =>
                  session
                    ? Try.success(session)
                    : Try.failure(new Error("Chat session not found")),
              )
            : Try.success(new ChatSession());

        if (isFailure(chatSessionTry)) {
          await stream.writeSSE({
            event: "error",
            data: chatSessionTry.error.message,
          });
          return;
        }

        const chatSession = chatSessionTry.unwrap();
        const messages = chatSession.messages;

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
        });

        if (pp.returnPrompt) {
          await stream.writeSSE({
            event: "update-prompt",
            data: pp.processedPrompt,
          });
          return;
        }

        const finalMessage = pp.processedPrompt;

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

        const memoryTools = createKnowledgeGraphTools({
          path: memoryFilePath,
        });

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
          .with("brainstorm", () => [
            ...objectKeys(brainstormingTools),
            ...objectKeys(thinkingTools),
          ])
          .exhaustive();

        const usedTools = messages
          .flatMap((msg) => {
            if (Array.isArray(msg.content)) {
              return msg.content.map((c) => {
                if (c.type === "tool-call") {
                  return c.toolName;
                }
                return "";
              });
            }
            return "";
          })
          .filter((tool) => tool.length > 0);

        const systemPrompt = system ?? generateSystemPrompt(new Date());

        const maxSteps = 15;
        const start = performance.now();

        const result = streamText({
          model: langModel,
          temperature: temperature ?? 0.3,
          maxTokens: maxTokens ?? 8192,
          tools: allTools,
          // biome-ignore lint/style/useNamingConvention: <explanation>
          experimental_activeTools: [
            ...new Set(activeTools.concat(usedTools as any[])),
          ],
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
            // Save chat session and interaction
            chatSession.messages.push(...result.response.messages);
            chatSession.markModified("messages");
            await chatSession.save();

            const i: Omit<InteractionInterface, "timestamp"> = {
              model: result.response.modelId,
              params: {
                temperature: temperature ?? 0.3,
                maxTokens: maxTokens ?? 8192,
                activeTools,
              },
              messages: messages.concat(result.response.messages),
              usage: {
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
              },
              app: "acai-chat",
              duration: performance.now() - start,
            };

            const interaction = new Interaction(i);
            await interaction.save();

            const metadata = parseMetadata(result.providerMetadata);

            await stream.writeSSE({
              event: "complete",
              data: JSON.stringify({
                sources: metadata.sources,
                chatSessionId: chatSession._id,
              }),
            });

            await stream.writeSSE({
              event: "close",
              data: "request finished",
            });
          },
          onError: async ({ error }) => {
            console.error(error);
            await stream.writeSSE({
              event: "error",
              data: (error as Error).message,
            });
            await stream.writeSSE({
              event: "close",
              data: "request error",
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
