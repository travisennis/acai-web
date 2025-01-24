import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { directoryTree, loadUrl } from "@travisennis/acai-core/tools";

export async function processPrompt(
  message: string,
  { baseDir }: { baseDir: string },
) {
  const lines = message.split("\n");
  const processedLines: string[] = [];
  const attachments: Buffer[] = [];
  let projectDir: string | null = null;
  let fileDirectiveFound = false;
  for (const line of lines) {
    if (line.startsWith("@projectdir")) {
      const project = line.replace("@projectdir ", "").trim();

      projectDir = path.join(baseDir, project);
      if (!existsSync(projectDir)) {
        throw new Error(`${projectDir} does not exist.`);
      }
      processedLines.push(
        `I'm giving you access to the following directory ${projectDir}\n`,
      );
    } else if (line.startsWith("@list-prompts")) {
      fileDirectiveFound = true;

      const files = await fs.readdir(`${baseDir}/prompts`);

      const fileNamesWithoutExtension = files.map(
        (file) => path.parse(file).name,
      );

      processedLines.push(
        `Prompts:\n${fileNamesWithoutExtension.join("\n")}\n`,
      );
    } else if (line.startsWith("@prompt")) {
      fileDirectiveFound = true;
      const promptName = line.replace("@prompt", "").trim();
      if (!promptName) {
        throw new Error("Prompt name cannot be empty");
      }

      const f = await fs.readFile(
        `${baseDir}/prompts/${promptName}.md`,
        "utf8",
      );

      processedLines.push(`${f}`);
    } else if (line.startsWith("@file")) {
      fileDirectiveFound = true;
      const filePath = line.replace("@file", "").trim();
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
    } else if (line.startsWith("@files")) {
      fileDirectiveFound = true;
      const filePaths = line.replace("@files", "");
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

      const tree = await directoryTree(`${baseDir}${filePath}`);
      processedLines.push(`File tree:\n${tree}\n`);
    } else if (line.startsWith("@url ")) {
      fileDirectiveFound = true;
      const urlPath = line.replace("@url ", "").trim();
      try {
        const clean = await loadUrl(urlPath);
        processedLines.push(
          `URL: ${urlPath}\n\`\`\`\n${clean.trim()}\n\`\`\`\n`,
        );
      } catch (error) {
        processedLines.push(`Url:${urlPath}\nStatus: ${error}`);
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
