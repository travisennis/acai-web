import { useState } from "hono/jsx";
import { client } from "./instruct-client";

export const useChatForm = () => {
  const [content, setContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (formData: FormData) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await client.instruct.$post({ form: formData });
      const data = await response.json();
      setContent(data.content);
    } catch (err) {
      setError("Failed to send message");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return { content, isLoading, error, handleSubmit };
};
