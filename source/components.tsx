import { Fragment } from "hono/jsx";

const Models = [
  "anthropic:sonnet",
  "anthropic:haiku",
  "openai:gpt-4o",
  "openai:gpt-4o-mini",
  "openai:o1",
  "openai:o1-mini",
  "google:pro",
  "google:flash",
  "google:flash2",
] as const;

export type ModelName = (typeof Models)[number];

const ModelList = ({
  selectedModel = "anthropic:sonnet",
}: { selectedModel: ModelName }) => (
  <Fragment>
    {Models.map((model) => (
      <option key={model} value={model} selected={model === selectedModel}>
        {model}
      </option>
    ))}
  </Fragment>
);

const ModeList = () => (
  <Fragment>
    <option value="instruct">Normal</option>
    <option value="bon">Best-of-N</option>
    <option value="cot">Chain-of-Thought</option>
    <option value="leap">LEAP</option>
    <option value="moa">Mixture-of-Agent</option>
    <option value="plansearch">Plansearch</option>
    <option value="tot">Tree-of-Thought</option>
  </Fragment>
);

export const SideBar = ({
  selectedModel,
  maxTokens,
  temperature,
}: { selectedModel: ModelName; maxTokens: number; temperature: number }) => {
  return (
    <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 shadow-sm">
      <div className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="model"
            className="block text-sm font-medium text-gray-700"
          >
            Model
          </label>
          <select
            id="model"
            name="model"
            defaultValue={selectedModel}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white shadow-sm focus:border-blue-500 focus:ring-blue-500"
          >
            <ModelList selectedModel={selectedModel}></ModelList>
          </select>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="maxTokens"
            className="block text-sm font-medium text-gray-700"
          >
            Max Tokens
          </label>
          <input
            type="number"
            id="maxTokens"
            name="maxTokens"
            min="0"
            max="8192"
            step="1"
            value={maxTokens}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white shadow-sm focus:border-blue-500 focus:ring-blue-500"
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="temperature"
            className="block text-sm font-medium text-gray-700"
          >
            Temperature
          </label>
          <input
            type="number"
            id="temperature"
            name="temperature"
            step="0.1"
            min="0"
            max="2"
            value={temperature}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white shadow-sm focus:border-blue-500 focus:ring-blue-500"
          />
        </div>

        {/* Mode Dropdown */}
        <div className="space-y-2">
          <label
            htmlFor="mode"
            className="block text-sm font-medium text-gray-700"
          >
            Mode
          </label>
          <select
            id="mode"
            name="mode"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white shadow-sm focus:border-blue-500 focus:ring-blue-500"
          >
            <ModeList></ModeList>
          </select>
        </div>
      </div>
    </div>
  );
};
