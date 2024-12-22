import { zValidator } from "@hono/zod-validator";
import {
	languageModel,
	middleware,
	type ModelName,
	wrapLanguageModel,
} from "@travisennis/ai-sdk-ext";
import { type CoreMessage, generateText } from "ai";
import { type Env, Hono } from "hono";
import path from "node:path";
import { z } from "zod";

const app = new Hono<Env>();

const messages: CoreMessage[] = [];

app.post(
	"/",
	zValidator(
		"json",
		z.object({
			model: z.string().optional(),
			maxTokens: z.coerce.number().optional(),
			temperature: z.coerce.number().optional(),
			message: z.string(),
			mode: z.string().optional(),
		}),
	),
	async (c) => {
		const { model, maxTokens, temperature, message, mode } =
			c.req.valid("json");

		messages.push({
			role: "user",
			content: message,
		});

		const { text } = await generateText({
			model: wrapLanguageModel(
				languageModel((model as ModelName) ?? "anthropic:sonnet"),
				middleware.log,
				middleware.usage,
				middleware.auditMessage({ path: path.join("data", "messages.jsonl") }),
			),
			temperature: temperature ?? 0.3,
			maxTokens: maxTokens ?? 8192,
			system: `You are a very helpful assistant that is focused on helping solve hard problems.`,
			messages: messages,
		});

		messages.push({
			role: "assistant",
			content: text,
		});

		return c.json(
			{
				content: text.trim(),
			},
			200,
		);
	},
);

export default app;
