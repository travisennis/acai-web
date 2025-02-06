import type { CoreMessage } from "ai";
import { Schema, model } from "mongoose";

export interface InteractionInterface {
  model: string;
  params: {
    temperature: number;
    maxTokens: number;
    activeTools: string[];
  };
  messages: CoreMessage[];
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  duration: number;
  app: string;
  timestamp: Date;
}

const interactionSchema = new Schema<InteractionInterface>({
  model: { type: String, required: true },
  params: {
    temperature: { type: Number, required: true },
    maxTokens: { type: Number, required: true },
    activeTools: { type: [String], required: true },
  },
  messages: { type: Schema.Types.Mixed, required: true },
  usage: {
    promptTokens: { type: Number, required: true },
    completionTokens: { type: Number, required: true },
  },
  duration: { type: Number },
  app: { type: String },
  timestamp: { type: Date, required: true, default: Date.now },
});

export const Interaction = model<InteractionInterface>(
  "Interactions",
  interactionSchema,
);

export interface PromptInterface {
  name: string;
  content: string;
  role: "system" | "user";
}

const promptSchema = new Schema<PromptInterface>(
  {
    name: { type: String, required: true },
    content: { type: String, required: true },
    role: { type: String, enum: ["system", "user"], required: true },
  },
  {
    timestamps: true,
  },
);

export const Prompt = model<PromptInterface>("Prompts", promptSchema);

export interface PageInterface {
  name: string;
  content: string;
}

const pageSchema = new Schema<PageInterface>(
  {
    name: { type: String, required: true },
    content: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

export const Page = model<PageInterface>("Pages", pageSchema);

export interface ChatSessionInterface {
  messages: CoreMessage[];
}

const chatSessionSchema = new Schema<ChatSessionInterface>(
  {
    messages: { type: Schema.Types.Mixed, required: true, default: [] },
  },
  {
    timestamps: true,
  },
);

export const ChatSession = model<ChatSessionInterface>(
  "ChatSessions",
  chatSessionSchema,
);
