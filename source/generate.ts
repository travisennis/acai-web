import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type ModelName,
  isSupportedModel,
  languageModel,
  wrapLanguageModel,
} from "@travisennis/ai-sdk-ext";
import { auditMessage, log, usage } from "@travisennis/ai-sdk-ext/middleware";
import { generateText, type LanguageModel } from "ai";
import { type Env, Hono } from "hono";
import { z } from "zod";

const app = new Hono<Env>();

app.post(
  "/",
  zValidator(
    "json",
    z.object({
      model: z.string().optional(),
      maxTokens: z.coerce.number().optional(),
      temperature: z.coerce.number().optional(),
      message: z.string(),
    }),
  ),
  async (c) => {
    const { model, maxTokens, temperature, message } = c.req.valid("json");

    const chosenModel: ModelName = isSupportedModel(model)
      ? model
      : "anthropic:sonnet";

    const langModel = wrapLanguageModel(
      languageModel(chosenModel),
      log,
      usage,
      auditMessage({ path: path.join("data", "messages.jsonl") }),
    );

    // Execute the loop
    const result = await loop(
      langModel,
      message,
      evaluatorPrompt,
      generatorPrompt,
    );

    return c.json(
      {
        content: `${result[2]}\n\nFinal result:\n${result[0]}`,
      },
      200,
    );
  },
);

interface ChainOfThoughtItem {
  thoughts: string;
  result: string;
}

async function llmCall(model: LanguageModel, prompt: string): Promise<string> {
  const { text } = await generateText({
    model,
    maxTokens: 4096,
    temperature: 0.1,
    prompt,
  });
  return text;
}

function extractXml(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}>(.*?)</${tag}>`, "s"));
  return match ? match[1] : "";
}

const evaluatorPrompt = `
Evaluate this following code implementation for:
1. code correctness
2. time complexity
3. style and best practices

You should be evaluating only and not attemping to solve the task.
Only output "PASS" if all criteria are met and you have no further suggestions for improvements.
Output your evaluation concisely in the following format.

<evaluation>PASS, NEEDS_IMPROVEMENT, or FAIL</evaluation>
<feedback>
What needs improvement and why.
</feedback>
`;

const generatorPrompt = `
Your goal is to complete the task based on <user input>. If there are feedback 
from your previous generations, you should reflect on them to improve your solution

Output your answer concisely in the following format: 

<thoughts>
[Your understanding of the task and feedback and how you plan to improve]
</thoughts>

<response>
[Your code implementation here]
</response>
`;

function createTaskPrompt(prompt: string): string {
  const result = `
<user input>
${prompt}
</user input>
`;

  return result;
}

async function generate(
  model: LanguageModel,
  prompt: string,
  task: string,
  context?: string,
): Promise<[string, string]> {
  const fullPrompt = context
    ? `${prompt}\n${context}\nTask: ${createTaskPrompt(task)}`
    : `${prompt}\nTask: ${createTaskPrompt(task)}`;

  const response = await llmCall(model, fullPrompt);
  const thoughts = extractXml(response, "thoughts");
  const result = extractXml(response, "response");

  return [thoughts, result];
}

function formatGenerateOutput([thoughts, result]: [string, string]): string {
  return `
=== GENERATION START ===
Thoughts:
${thoughts}

Generated:
${result}
=== GENERATION END ===
`;
}

async function evaluate(
  model: LanguageModel,
  prompt: string,
  content: string,
  task: string,
): Promise<[string, string]> {
  const fullPrompt = `${prompt}\nOriginal task: ${createTaskPrompt(task)}\nContent to evaluate: ${content}`;
  const response = await llmCall(model, fullPrompt);
  const evaluation = extractXml(response, "evaluation");
  const feedback = extractXml(response, "feedback");

  return [evaluation, feedback];
}

function formatEvaluateOutput([evaluation, feedback]: [
  string,
  string,
]): string {
  return `=== EVALUATION START ===\nStatus: ${evaluation}\nFeedback: ${feedback}\n=== EVALUATION END ===\n`;
}

async function loop(
  model: LanguageModel,
  task: string,
  evaluatorPrompt: string,
  generatorPrompt: string,
): Promise<[string, ChainOfThoughtItem[], string]> {
  let fullOutput = "";
  const memory: string[] = [];
  const chainOfThought: ChainOfThoughtItem[] = [];

  const [thoughts, result] = await generate(model, generatorPrompt, task);
  fullOutput += formatGenerateOutput([thoughts, result]);

  memory.push(result);
  chainOfThought.push({ thoughts, result });

  const max = 5;
  let i = 0;
  while (true) {
    if (i++ > max) {
      fullOutput += "max attempts";
      return [result, chainOfThought, fullOutput];
    }

    const lastResult = memory.at(-1);

    if (!lastResult) {
      fullOutput += "no result";
      return [result, chainOfThought, fullOutput];
    }

    const [evaluation, feedback] = await evaluate(
      model,
      evaluatorPrompt,
      lastResult,
      task,
    );

    fullOutput += formatEvaluateOutput([evaluation, feedback]);

    if (evaluation === "PASS") {
      return [result, chainOfThought, fullOutput];
    }

    const context = [
      "Previous attempts:",
      ...memory.map((m) => `- ${m}`),
      `\nFeedback: ${feedback}`,
    ].join("\n");

    const [newThoughts, newResult] = await generate(
      model,
      generatorPrompt,
      task,
      context,
    );

    fullOutput += formatGenerateOutput([newThoughts, newResult]);

    memory.push(newResult);
    chainOfThought.push({ thoughts: newThoughts, result: newResult });
  }
}

export default app;
// let planningPrompt = `
//     You are an expert software architect and product lead responsible for taking an idea of an app, analyzing it, and producing an implementation plan for a single page React frontend app.

//     Guidelines:

//     - Focus on MVP - Describe the Minimum Viable Product, which are the essential set of features needed to launch the app. Identify and prioritize the top 2-3 critical features.
//     - Detail the High-Level Overview - Begin with a broad overview of the app’s purpose and core functionality, then detail specific features. Break down tasks into two levels of depth (Features → Tasks → Subtasks).
//     - Be concise, clear, and straight forward. Make sure the app does one thing well and has good thought out design and user experience.
//     - Do not include any external API calls.
//     - Skip code examples and commentary.
//   `;
// let systemPrompt = `
//     You are an expert frontend React engineer who is also a great UI/UX designer. Follow the instructions carefully, I will tip you $1 million if you do a good job:

//     - Think carefully step by step.
//     - Create a React component for whatever the user asked you to create and make sure it can run by itself by using a default export.
//     - Make sure the React app is interactive and functional by creating state when needed and having no required props.
//     - If you use any imports from React like useState or useEffect, make sure to import them directly.
//     - Use TypeScript as the language for the React component.
//     - Use Tailwind classes for styling. DO NOT USE ARBITRARY VALUES (e.g. \`h-[600px]\`). Make sure to use a consistent color palette.
//     - Use Tailwind margin and padding classes to style the components and ensure the components are spaced out nicely.
//     - Please ONLY return the full React code starting with the imports, nothing else. It's very important for my job that you only return the React code with imports. DO NOT START WITH \`\`\`typescript or \`\`\`javascript or \`\`\`tsx or \`\`\`.
//     - ONLY IF the user asks for a dashboard, graph or chart, the recharts library is available to be imported, e.g. \`import { LineChart, XAxis, ... } from "recharts"\` & \`<LineChart ...><XAxis dataKey="name"> ...\`. Please only use this when needed.
//     - For placeholder images, please use a <div className="bg-gray-200 border-2 border-dashed rounded-xl w-16 h-16" />.
//     - The lucide-react library is also available to be imported IF NECCESARY ONLY FOR THE FOLLOWING ICONS: Heart, Shield, Clock, Users, Play, Home, Search, Menu, User, Settings, Mail, Bell, Calendar, Clock, Heart, Star, Upload, Download, Trash, Edit, Plus, Minus, Check, X, ArrowRight. Here's an example of importing and using one: import { Heart } from "lucide-react"\` & \`<Heart className=""  />\`. PLEASE ONLY USE THE ICONS IF AN ICON IS NEEDED IN THE USER'S REQUEST.
//   `;
