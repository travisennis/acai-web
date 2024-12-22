import { hc } from "hono/client";
import { useState } from "hono/jsx";
import { render } from "hono/jsx/dom";
import type { AppType } from "./index.tsx";
import { SideBar } from "./components.tsx";
import type { InferRequestType } from "hono/client";

export const client = hc<AppType>("/");

type FormData = InferRequestType<typeof client.instruct.$post>;

const useChatForm = () => {
  const [content, setContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (formData: FormData) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await client.instruct.$post(formData);
      const data = await response.json();
      setContent(data.content);
    } catch (err) {
      setError("Failed to send message");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return { content, setContent, isLoading, error, handleSubmit };
};

const ChatForm = () => {
  const { content, setContent, isLoading, error, handleSubmit } = useChatForm();

  const onSubmit = (e: Event) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    handleSubmit({
      form: {
        message: formData.get("message") as string,
      },
    });
  };

  // Add new handler for keyboard events
  const handleKeyDown = (e: KeyboardEvent) => {
    // Check if Ctrl+Enter (or Cmd+Enter for Mac) was pressed
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault(); // Prevent default behavior
      const form = document.getElementById("chatForm") as HTMLFormElement;
      const formData = new FormData(form);
      handleSubmit({
        form: {
          message: formData.get("message") as string,
        },
      });
    }
  };

  return (
    <form
      id="chatForm"
      method="post"
      className="h-full flex flex-col"
      onSubmit={onSubmit}
    >
      <div className="flex flex-1 min-h-0 gap-6">
        <div className="flex-grow flex flex-col">
          <div className="flex-1 relative">
            <textarea
              id="message"
              name="message"
              className="h-full w-full rounded-lg border border-gray-300 p-4 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 shadow-sm"
              value={content}
              onChange={(e: Event) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter your message here...(Ctrl+Enter to submit)"
            />
          </div>
          {error && <div className="text-red-500 mt-2">{error}</div>}
          <div className="flex justify-end mt-4 pb-2">
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed shadow-sm"
            >
              {isLoading ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Processing...
                </>
              ) : (
                "Send"
              )}
            </button>
          </div>
        </div>

        <div className="w-72 flex-shrink-0">
          <SideBar
            selectedModel="anthropic:sonnet"
            maxTokens={8192}
            temperature={0.3}
          />
        </div>
      </div>
    </form>
  );
};

const App = () => {
  return (
    <div className="h-full bg-gray-50 p-4 overflow-hidden">
      <div className="h-full mx-auto max-w-7xl">
        <div className="h-full rounded-lg bg-white p-6 shadow-lg flex flex-col">
          <ChatForm />
        </div>
      </div>
    </div>
  );
};

const root = document.getElementById("root")!;
render(<App />, root);
