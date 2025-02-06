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
import { objectKeys } from "@travisennis/stdlib/object";
import { asyncTry } from "@travisennis/stdlib/try";
import { generateText } from "ai";
import { Hono } from "hono";
import type { Document } from "mongoose";
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

export const app = new Hono().get("/", (c) => {
  return c.json(
    {
      modes: modes,
    },
    200,
  );
});
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
      chatSessionId: z.string().optional(),
      mode: z.string().optional(),
    }),
  ),
  async (c) => {
    const {
      model,
      maxTokens,
      temperature,
      system,
      message,
      chatSessionId,
      mode,
    } = c.req.valid("json");

    // Get or create chat session
    let chatSession;
    if (chatSessionId) {
      chatSession = await ChatSession.findById(chatSessionId);
      if (!chatSession) {
        return c.json(
          {
            message: "Chat session not found",
          },
          404,
        );
      }
    } else {
      chatSession = new ChatSession();
    }

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
      // usage,
      // log,
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
    //   message,
    // });

    const activeTools: (keyof typeof allTools)[] = match(chosenMode)
      .with("normal", () => [])
      .with("research", () => [
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
    const { response, reasoning, usage, experimental_providerMetadata } =
      await generateText({
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

    chatSession.messages.push(...response.messages);
    chatSession.markModified("messages");
    await chatSession.save();

    const metadata = parseMetadata(experimental_providerMetadata);

    return c.json(
      {
        messages: response.messages,
        reasoning: reasoning,
        sources: metadata.sources,
        chatSessionId: chatSession._id,
      },
      200,
    );
  },
);
