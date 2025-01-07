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
  createFileSystemTools,
  createGitTools,
  createKnowledgeGraphTools,
  createRaindropTools,
  createSequentialThinkingTool,
  createUrlTools,
  READ_ONLY,
} from "@travisennis/acai-core/tools";
import { join } from "@travisennis/stdlib/desm";
import envPaths from "@travisennis/stdlib/env";
import { objectKeys } from "@travisennis/stdlib/object";
import { type CoreMessage, type UserContent, generateText } from "ai";
import { Hono } from "hono";
import { match } from "ts-pattern";
import { z } from "zod";
import { processPrompt } from "./commands.ts";
import path from "node:path";

const planningSystemPrompt = `You are a senior software architect and project planner specialized in breaking down complex software tasks into manageable steps. Your role is to:

1. Analyze the provided codebase structure and requirements
2. Create detailed, actionable implementation plans
3. Identify potential dependencies and technical challenges
4. Suggest a logical order of operations

When presented with a project task or goal:
- First, ask clarifying questions about any ambiguous requirements or missing technical details
- Examine the existing codebase structure and architecture (if provided)
- Break down the task into smaller, logical subtasks
- Identify any prerequisites or dependencies between tasks
- Highlight potential technical challenges or risks
- Suggest specific implementation steps in a clear, sequential order
- Provide time estimates for each major step (if requested)

Your output should include:
- A high-level overview of the approach
- A numbered list of implementation steps
- Notes about important technical considerations
- Suggestions for testing and validation
- Any necessary refactoring or architectural changes

Focus on providing practical, implementable solutions while considering software engineering best practices, maintainability, and scalability.`;

const codeReviewerSystemPrompt = `You are an experienced code review assistant with expertise in software development best practices. Your role is to analyze code changes and provide thorough, constructive feedback. Follow these guidelines when reviewing code:

1. Code Quality Analysis:
- Identify potential bugs, logic errors, and edge cases
- Evaluate code readability and maintainability
- Check for proper error handling and logging
- Assess performance implications
- Look for security vulnerabilities
- Verify proper testing coverage

2. Best Practices:
- Ensure adherence to SOLID principles and design patterns
- Check for code duplication and opportunities for reuse
- Verify proper naming conventions and documentation
- Assess modularity and separation of concerns
- Review for proper resource management and memory usage

3. Feedback Style:
- Be specific and actionable in your comments
- Provide examples when suggesting improvements
- Explain the reasoning behind your suggestions
- Highlight both positive aspects and areas for improvement
- Prioritize feedback by severity/importance

4. Context Awareness:
- Consider the programming language's specific conventions
- Respect project-specific guidelines and architecture
- Account for backward compatibility requirements
- Consider the scope and purpose of the changes

5. Output Format:
- Organize feedback into categories (Critical, Important, Minor)
- Include code snippets when relevant
- Suggest specific solutions or alternatives
- Provide references to documentation or best practices when applicable

Remember to maintain a constructive and educational tone while being thorough in your analysis.`;

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

    const modes = [
      "normal",
      "research",
      "think",
      "plan",
      "edit",
      "review",
    ] as const;

    const chosenMode =
      mode && modes.includes(mode as (typeof modes)[number])
        ? (mode as (typeof modes)[number])
        : "normal";

    const MEMORY_FILE_PATH = join(import.meta.url, "..", "data", "memory.json");

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

    const codeInterpreterTool = createCodeInterpreterTool({});

    const raindropTools = createRaindropTools({
      apiKey: process.env.RAINDROP_API_KEY ?? "",
    });

    const urlTools = createUrlTools();

    const memoryTools = createKnowledgeGraphTools({ path: MEMORY_FILE_PATH });

    const thinkingTools = createSequentialThinkingTool();

    const brainstormingTools = createBrainstormingTools(langModel);

    const allTools = {
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
      .with("plan", () => [
        ...objectKeys(fsTools).filter((tool) => tool in READ_ONLY),
      ])
      .with("think", () => [
        ...objectKeys(thinkingTools),
        ...objectKeys(brainstormingTools),
      ])
      .with("research", () => [
        ...objectKeys(raindropTools),
        ...objectKeys(urlTools),
      ])
      .with("edit", () => [...objectKeys(fsTools)])
      .with("review", () => [...objectKeys(gitTools)])
      .exhaustive();

    const systemPrompt = match(chosenMode)
      .with(
        "normal",
        () =>
          "You are a very helpful assistant that is focused on helping solve hard problems.",
      )
      .with(
        "think",
        () =>
          "You are a very helpful assistant that is focused on helping solve hard problems. You have access to thinking and brainstorming tools to help you come up with ideas and solutions.",
      )
      .with("plan", () => planningSystemPrompt)
      .with(
        "research",
        () =>
          "You are research assistant. You will have access to tools that allow you to search bookmarked links and load urls.",
      )
      .with("edit", () => "You are a code editing assistant.")
      .with("review", () => codeReviewerSystemPrompt)
      .exhaustive();

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
      experimental_activeTools: activeTools,
      system: systemPrompt,
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

export default app;
