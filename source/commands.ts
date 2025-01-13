import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BODY_CONTENTS = /<body[^>]*>([\s\S]*?)<\/body>/i;
export async function processPrompt(
  message: string,
  { baseDir }: { baseDir: string },
) {
  const lines = message.split("\n");
  const processedLines: string[] = [];
  const attachments: Buffer[] = [];
  let projectDir: string | null = null;
  let fileDirectiveFound = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("@projectdir")) {
      const project = line.replace("@projectdir ", "").trim();

      projectDir = path.join(baseDir, project);
      if (!existsSync(projectDir)) {
        throw new Error(`${projectDir} does not exist.`);
      }
    } else if (line.startsWith("@list-prompts")) {
      fileDirectiveFound = true;

      const files = await fs.readdir(`${baseDir}/prompts`);

      const fileNamesWithoutExtension = files.map(
        (file) => path.parse(file).name,
      );

      processedLines.push(
        `Prompts:\n${fileNamesWithoutExtension.join("\n")}\n`,
      );
    } else if (line.startsWith("@prompt ")) {
      fileDirectiveFound = true;
      const promptName = line.replace("@prompt ", "").trim();
      if (!promptName) {
        throw new Error("Prompt name cannot be empty");
      }

      const f = await fs.readFile(
        `${baseDir}/prompts/${promptName}.md`,
        "utf8",
      );

      processedLines.push(`${f}`);
    } else if (line.startsWith("@file ")) {
      fileDirectiveFound = true;
      const filePath = line.replace("@file ", "").trim();
      const fileExtension = filePath.split(".").pop();
      const codeBlockName =
        {
          js: "javascript",
          ts: "typescript",
          py: "python",
          rb: "ruby",
          java: "java",
          cpp: "cpp",
          cs: "csharp",
          go: "go",
          rs: "rust",
          php: "php",
          html: "html",
          css: "css",
          json: "json",
          yml: "yaml",
          yaml: "yaml",
          md: "markdown",
          sql: "sql",
          sh: "bash",
          bash: "bash",
          txt: "text",
        }[fileExtension ?? ""] || filePath.split(".").pop();

      const f = await fs.readFile(`${baseDir}${filePath}`.trim(), "utf8");

      processedLines.push(
        `File: ${filePath}\n\`\`\` ${codeBlockName}\n${f}\n\`\`\``,
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
        const processedText = (text.match(BODY_CONTENTS)?.[1] || "").replace(
          /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
          "",
        );
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

  return {
    processedPrompt: processedLines.join("\n").trim(),
    attachments,
    returnPrompt: fileDirectiveFound,
    projectDir,
  };
}
