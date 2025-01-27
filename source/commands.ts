import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { directoryTree, loadUrl } from "@travisennis/acai-core/tools";

interface CommandContext {
  baseDir: string;
  line: string;
  processedLines: string[];
  attachments: Buffer[];
}

const codeBlockExtensions: Record<string, string> = {
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
};

async function processListPrompts(context: CommandContext) {
  const { baseDir, processedLines } = context;
  const files = await fs.readdir(path.join(baseDir, "prompts"));
  const fileNamesWithoutExtension = files.map((file) => path.parse(file).name);
  processedLines.push(`Prompts:\n${fileNamesWithoutExtension.join("\n")}\n`);
  return true;
}

async function processPromptCommand(context: CommandContext) {
  const { baseDir, line, processedLines } = context;
  const promptName = line.replace("@prompt", "").trim();
  if (!promptName) {
    throw new Error("Prompt name cannot be empty");
  }

  const f = await fs.readFile(
    path.join(baseDir, "prompts", `${promptName}.md`),
    "utf8",
  );
  processedLines.push(`${f}`);
  return true;
}

async function processFileCommand(context: CommandContext) {
  const { baseDir, line, processedLines } = context;
  const filePath = line.replace("@file", "").trim();
  const fileExtension = filePath.split(".").pop() || "";
  const codeBlockName = codeBlockExtensions[fileExtension] || fileExtension;

  try {
    const f = await fs.readFile(path.join(baseDir, filePath.trim()), "utf8");
    processedLines.push(
      `File: ${filePath}\n\`\`\` ${codeBlockName}\n${f}\n\`\`\``,
    );
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      processedLines.push(`Error: File not found: ${filePath}\nPlease check that the file path is correct and the file exists.`);
    } else {
      processedLines.push(`Error reading file ${filePath}: ${error.message}`);
    }
    return true;
  }
}

async function processFilesCommand(context: CommandContext) {
  const { baseDir, line, processedLines } = context;
  const filePaths = line.replace("@files", "");
  for (const filePath of filePaths.split(" ")) {
    if (!filePath.trim()) {
      continue;
    }
    try {
      const fileExtension = filePath.split(".").pop() || "";
      const codeBlockName = codeBlockExtensions[fileExtension] || fileExtension;
      const f = await fs.readFile(path.join(baseDir, filePath.trim()), "utf8");
      processedLines.push(
        `File: ${filePath}\n\`\`\` ${codeBlockName}\n${f}\n\`\`\``,
      );
    } catch (error) {
      if (error.code === 'ENOENT') {
        processedLines.push(`Error: File not found: ${filePath}\nPlease check that the file path is correct and the file exists.`);
      } else {
        processedLines.push(`Error reading file ${filePath}: ${error.message}`);
      }
    }
  }
  return true;
}

async function processDirCommand(context: CommandContext) {
  const { baseDir, line, processedLines } = context;
  const dirPath = line.replace("@dir", "").trim();
  try {
    const fullPath = path.join(baseDir, dirPath);
    // Check if directory exists first
    await fs.access(fullPath);
    const tree = await directoryTree(fullPath);
    processedLines.push(`File tree:\n${tree}\n`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      processedLines.push(`Error: Directory not found: ${dirPath}\nPlease check that the directory path is correct and exists.`);
    } else {
      processedLines.push(`Error reading directory ${dirPath}: ${error.message}`);
    }
  }
  return true;
}

async function processUrlCommand(context: CommandContext) {
  const { line, processedLines } = context;
  const urlPath = line.replace("@url ", "").trim();
  try {
    const clean = await loadUrl(urlPath);
    processedLines.push(`URL: ${urlPath}\n\`\`\`\n${clean.trim()}\n\`\`\`\n`);
  } catch (error) {
    processedLines.push(`Url:${urlPath}\nStatus: ${error}`);
  }
  return true;
}

function processProjectDirCommand(context: CommandContext) {
  const { baseDir, line, processedLines } = context;
  const project = line.replace("@projectdir ", "").trim();
  const projectDir = path.join(baseDir, project);

  if (existsSync(projectDir)) {
    processedLines.push(
      `I'm giving you access to the following directory ${projectDir}\n`,
    );
  } else {
    processedLines.push(`@projectdir ${projectDir} does not exist.`);
  }
  return projectDir;
}

async function processPdfCommand(context: CommandContext) {
  const { line, attachments } = context;
  const pdfUrl = line.replace("@pdf ", "");
  const response = await fetch(pdfUrl);
  const buffer = await response.arrayBuffer();
  const pdfBuffer = Buffer.from(buffer);
  attachments.push(pdfBuffer);
  return false;
}

const commandHandlers: Record<
  string,
  (context: CommandContext) => Promise<boolean | string | null>
> = {
  "@list-prompts": processListPrompts,
  "@prompt": processPromptCommand,
  "@file": processFileCommand,
  "@files": processFilesCommand,
  "@dir": processDirCommand,
  "@url": processUrlCommand,
};

export async function processPrompt(
  message: string,
  { baseDir }: { baseDir: string },
) {
  const lines = message.split("\n");
  const processedLines: string[] = [];
  const attachments: Buffer[] = [];
  let projectDir: string | null = null;
  let fileDirectiveFound = false;

  // First pass: Process all commands except @projectdir and @pdf
  for (const line of lines) {
    const command = Object.keys(commandHandlers).find((cmd) =>
      line.startsWith(cmd),
    );

    if (command) {
      const context = {
        baseDir,
        line,
        processedLines,
        attachments,
      };
      fileDirectiveFound = true;
      await commandHandlers[command](context);
    } else if (!(line.startsWith("@projectdir") || line.startsWith("@pdf"))) {
      processedLines.push(line);
    }
  }

  // Second pass: Process @projectdir and @pdf only if no other commands were found
  if (!fileDirectiveFound) {
    for (const line of lines) {
      if (line.startsWith("@projectdir")) {
        const context = {
          baseDir,
          line,
          processedLines,
          attachments,
        };
        projectDir = processProjectDirCommand(context);
      } else if (line.startsWith("@pdf")) {
        const context = {
          baseDir,
          line,
          processedLines,
          attachments,
        };
        await processPdfCommand(context);
      }
    }
  }

  return {
    processedPrompt: processedLines.join("\n").trim(),
    attachments,
    returnPrompt: fileDirectiveFound,
    projectDir,
  };
}
