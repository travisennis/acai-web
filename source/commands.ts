import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatFile } from "@travisennis/acai-core";
import { directoryTree, readUrl } from "@travisennis/acai-core/tools";
import { globby } from "globby";

interface CommandContext {
  model: string;
  baseDir: string;
  projectDir: string | null;
  line: string;
  processedLines: string[];
  attachments: Buffer[];
}

async function processListPrompts(context: CommandContext) {
  const { baseDir, processedLines } = context;
  const files = await fs.readdir(path.join(baseDir, "prompts"));
  const fileNamesWithoutExtension = files.map((file) => path.parse(file).name);
  processedLines.push(`Prompts:\n${fileNamesWithoutExtension.join("\n")}\n`);
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
}

async function processFileCommand(context: CommandContext) {
  const { baseDir, line, processedLines } = context;
  const filePath = line.replace("@file", "").trim();

  const format = context.model.includes("deepseek")
    ? "bracket"
    : context.model.includes("anthropic")
      ? "xml"
      : "markdown";
  try {
    const fileContents = await fs.readFile(
      path.join(baseDir, filePath.trim()),
      "utf8",
    );
    processedLines.push(formatFile(filePath, fileContents, format));
  } catch (error) {
    if ((error as { code: string }).code === "ENOENT") {
      processedLines.push(
        `Error: File not found: ${filePath}\nPlease check that the file path is correct and the file exists.`,
      );
    } else {
      processedLines.push(
        `Error reading file ${filePath}: ${(error as Error).message}`,
      );
    }
  }
}

async function processFilesCommand(context: CommandContext) {
  const { baseDir, line, processedLines, projectDir } = context;
  const format = context.model.includes("deepseek")
    ? "bracket"
    : context.model.includes("anthropic")
      ? "xml"
      : "markdown";
  const patterns = line
    .replace("@files", "")
    .trimStart()
    .split(" ")
    .map((p) => p.trim())
    .map((p) => (p.startsWith("/") ? p.slice(1) : p));
  const filePaths = await globby(patterns, {
    gitignore: true,
    cwd: projectDir ?? baseDir,
  });
  for (const filePath of filePaths) {
    if (!filePath.trim()) {
      continue;
    }
    try {
      const fileContents = await fs.readFile(
        path.join(baseDir, filePath.trim()),
        "utf8",
      );
      processedLines.push(formatFile(filePath, fileContents, format));
    } catch (error) {
      if ((error as { code: string }).code === "ENOENT") {
        processedLines.push(
          `Error: File not found: ${filePath}\nPlease check that the file path is correct and the file exists.`,
        );
      } else {
        processedLines.push(
          `Error reading file ${filePath}: ${(error as Error).message}`,
        );
      }
    }
  }
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
    if ((error as { code: string }).code === "ENOENT") {
      processedLines.push(
        `Error: Directory not found: ${dirPath}\nPlease check that the directory path is correct and exists.`,
      );
    } else {
      processedLines.push(
        `Error reading directory ${dirPath}: ${(error as Error).message}`,
      );
    }
  }
}

async function processUrlCommand(context: CommandContext) {
  const { line, processedLines } = context;
  const urlPath = line.replace("@url ", "").trim();
  try {
    const clean = await readUrl(urlPath);
    processedLines.push(`URL: ${urlPath}\n\`\`\`\n${clean.trim()}\n\`\`\`\n`);
  } catch (error) {
    processedLines.push(`Url:${urlPath}\nStatus: ${error}`);
  }
}

function processCommitCommand(context: CommandContext) {
  const { processedLines } = context;
  processedLines.push(
    "Read the code changes in the current directory and write a commit message and commit it. ",
  );
  return Promise.resolve();
}

function processProjectDirCommand(context: CommandContext) {
  const { baseDir, line, processedLines } = context;
  const project = line.replace("@projectdir ", "").trim();
  const projectDir = path.join(baseDir, project);

  if (existsSync(projectDir)) {
    context.projectDir = projectDir;
    processedLines.push(
      `I'm giving you access to the following directory ${projectDir}`,
    );
  } else {
    processedLines.push(`@projectdir ${projectDir} does not exist.`);
  }
  return Promise.resolve();
}

async function processPdfCommand(context: CommandContext) {
  const { line, attachments } = context;
  const pdfUrl = line.replace("@pdf ", "");
  const response = await fetch(pdfUrl);
  const buffer = await response.arrayBuffer();
  const pdfBuffer = Buffer.from(buffer);
  attachments.push(pdfBuffer);
}

const commandHandlers: Record<
  string,
  (context: CommandContext) => Promise<void>
> = {
  "@list-prompts": processListPrompts,
  "@prompt": processPromptCommand,
  "@files": processFilesCommand,
  "@file": processFileCommand,
  "@dir": processDirCommand,
  "@url": processUrlCommand,
};

const secondPassCommandHandlers: Record<
  string,
  (context: CommandContext) => Promise<void>
> = {
  "@projectdir": processProjectDirCommand,
  "@commit": processCommitCommand,
  "@pdf": processPdfCommand,
};

export async function processPrompt(
  message: string,
  { baseDir, model }: { baseDir: string; model: string },
) {
  const lines = message.split("\n");
  let processedLines: string[] = [];
  const attachments: Buffer[] = [];
  let projectDir: string | null = null;
  let fileDirectiveFound = false;

  // First pass: Process all commands except @projectdir, @commit and @pdf
  for (const line of lines) {
    const command = Object.keys(commandHandlers).find((cmd) =>
      line.startsWith(cmd),
    );

    if (command) {
      const context = {
        model,
        baseDir,
        projectDir,
        line,
        processedLines,
        attachments,
      };
      fileDirectiveFound = true;
      await commandHandlers[command](context);
    } else {
      processedLines.push(line);
    }
  }
  // Second pass: Process @projectdir and @pdf only if no other commands were found
  if (!fileDirectiveFound) {
    const temp: string[] = [];
    for (const line of processedLines) {
      const command = Object.keys(secondPassCommandHandlers).find((cmd) =>
        line.startsWith(cmd),
      );

      if (command) {
        const context: CommandContext = {
          model,
          baseDir,
          projectDir,
          line,
          processedLines: temp,
          attachments,
        };
        await secondPassCommandHandlers[command](context);
        projectDir = context.projectDir;
      } else {
        temp.push(line);
      }
    }
    processedLines = temp;
  }

  return {
    processedPrompt: processedLines.join("\n").trim(),
    attachments,
    returnPrompt: fileDirectiveFound,
    projectDir,
  };
}
