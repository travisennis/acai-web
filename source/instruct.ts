import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/ai-sdk-ext";
import { auditMessage, log, usage } from "@travisennis/ai-sdk-ext/middleware";
import {
  createCodeInterpreterTool,
  createFileSystemTools,
  createGitTools,
  createRaindropTools,
  createUrlTools,
} from "@travisennis/ai-sdk-ext/tools";
import { type CoreMessage, type UserContent, generateText } from "ai";
import { Hono } from "hono";
import { z } from "zod";

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

    const lines = message.split("\n");
    const processedLines: string[] = [];
    const attachments: Buffer[] = [];
    const baseDir = "/users/travisennis/github";
    let projectDir: string | null = null;
    let fileDirectiveFound = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("@projectdir")) {
        const project = line.replace("@projectdir ", "").trim();

        projectDir = path.join(baseDir, project);
        if (!existsSync(projectDir)) {
          return c.json(
            {
              content: `${projectDir} does not exist.`,
            },
            200,
          );
        }
      } else if (line.startsWith("@list-prompts")) {
        fileDirectiveFound = true;

        const dirs = await fs.readdir(`${baseDir}/prompts`);

        processedLines.push(`Prompts:\n${dirs.join("\n")}\n`);
      } else if (line.startsWith("@prompt ")) {
        fileDirectiveFound = true;
        const promptName = line.replace("@prompt ", "").trim();

        const f = await fs.readFile(
          `${baseDir}/prompts/${promptName}.md`,
          "utf8",
        );

        processedLines.push(`${f}`);
      } else if (line.startsWith("@file ")) {
        fileDirectiveFound = true;
        const filePath = line.replace("@file ", "").trim();
        const fileExtension = filePath.split(".").pop();

        const f = await fs.readFile(`${baseDir}${filePath}`.trim(), "utf8");

        processedLines.push(
          `File: ${filePath}\n\`\`\` ${fileExtension}\n${f}\n\`\`\``,
        );
      } else if (line.startsWith("@files ")) {
        fileDirectiveFound = true;
        const filePaths = line.replace("@files ", "");
        for (const filePath of filePaths.split(" ")) {
          const fileExtension = filePath.split(".").pop();
          const f = await fs.readFile(`${baseDir}${filePath}`.trim(), "utf8");

          processedLines.push(
            `File: ${filePath}\n\`\`\` ${fileExtension}\n${f}\n\`\`\``,
          );
        }
      } else if (line.startsWith("@dir")) {
        fileDirectiveFound = true;
        const filePath = line.replace("@dir", "").trim();

        const dirs = await fs.readdir(`${baseDir}${filePath}`);

        processedLines.push(`File tree:\n${dirs.join("\n")}\n`);
      } else if (line.startsWith("@url ")) {
        fileDirectiveFound = true;
        const urlPath = line.replace("@url ", "").trim();
        const response = await fetch(urlPath);
        if (!response.ok) {
          processedLines.push(`Url:${urlPath}\nStatus: ${response.status}`);
        } else {
          const text = await response.text();
          const processedText = (
            text.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || ""
          ).replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
          processedLines.push(
            `URL: ${urlPath}\n\`\`\`\n${processedText.trim()}\n\`\`\`\n`,
          );
        }
      } else if (line.startsWith("@pdf ")) {
        const pdfUrl = line.replace("@pdf ", "");

        const response = await fetch(pdfUrl);
        const buffer = await response.arrayBuffer();
        const pdfBuffer = Buffer.from(buffer);
        attachments.push(pdfBuffer);
      } else {
        processedLines.push(line);
      }
    }

    if (fileDirectiveFound) {
      return c.json(
        {
          content: processedLines.join("\n").trim(),
        },
        200,
      );
    }

    const finalMessage = processedLines.join("\n").trim();

    const messages: CoreMessage[] = [];
    if (attachments.length > 0) {
      const content: UserContent = [
        {
          type: "text",
          text: finalMessage,
        },
      ];

      for (const attachment of attachments) {
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
      messages.pus({
        role: "user",
        content: finalMessage,
      });
    }

    const fsTools = await createFileSystemTools({
      workingDir: projectDir ?? `${baseDir}/temp`,
    });

    const gitTools = await createGitTools({
      workingDir: projectDir ?? `${baseDir}/temp`,
    });

    const codeInterpreterTool = createCodeInterpreterTool({});

    const raindropTools = createRaindropTools({
      apiKey: process.env.RAINDROP_API_KEY ?? "",
    });

    const urlTools = createUrlTools();

    const allTools = {
      ...fsTools,
      ...gitTools,
      ...codeInterpreterTool,
      ...raindropTools,
      ...urlTools,
    };

    const { text } = await generateText({
      model: wrapLanguageModel(
        languageModel(chosenModel),
        log,
        usage,
        auditMessage({ path: path.join("data", "messages.jsonl") }),
      ),
      temperature: temperature ?? 0.3,
      maxTokens: maxTokens ?? 8192,
      tools: allTools,
      experimental_activeTools: [],
      system:
        "You are a very helpful assistant that is focused on helping solve hard problems.",
      messages,
      maxSteps: 5,
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
