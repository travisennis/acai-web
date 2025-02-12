import { languageModel, wrapLanguageModel } from "@travisennis/acai-core";
import { objectEntries, objectKeys } from "@travisennis/stdlib/object";
import { type Tool, extractReasoningMiddleware, generateText } from "ai";

export async function chooseActiveTools<T extends Record<string, Tool>>({
  tools,
  message,
}: { tools: T; message: string }): Promise<(keyof T)[]> {
  const toolDescriptions = objectEntries(tools).map(
    (tool) =>
      `Name: "${tool[0] as string}"\nDescription: "${(tool[1] as { description: string }).description}"`,
  );

  const system = `Your task is to determine the tools that are most useful for the user's given task which you will find in <task> tags.

Here are the tools available to choose from:
"${toolDescriptions.join("\n\n")}"

Make sure you fully understand the user's task, before deciding on the tools. Only respond with the tools that are most useful for the user's task. Your response should be a comma-separated list of the tool names. Only return the tool name once in your list. If no tools are needed then respond with an empty array.`;

  const enhancedModel = wrapLanguageModel(
    languageModel("google:flash2"),
    extractReasoningMiddleware({ tagName: "thinking" }),
  );

  const { text: chosenTools, reasoning } = await generateText({
    model: enhancedModel,
    system,
    prompt: `Task: <task>${message}</task>: Output:`,
  });

  const activeTools = chosenTools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) =>
      objectKeys(tools).includes(tool as keyof typeof tools),
    ) as (keyof typeof tools)[];

  console.dir(activeTools);

  return [...new Set(activeTools)];
}
