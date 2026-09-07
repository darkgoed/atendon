export interface OpenRouterChatRequestOptions {
  baseUrl: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  fetcher?: typeof fetch;
  appUrl?: string;
  appName?: string;
  titleHeader?: string;
}

/** Raw OpenRouter chat transport only. Policy belongs to each caller. */
export async function postOpenRouterChatCompletions(
  options: OpenRouterChatRequestOptions
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json"
  };
  if (options.appUrl) headers["HTTP-Referer"] = options.appUrl;
  if (options.appName) headers[options.titleHeader ?? "X-Title"] = options.appName;
  return (options.fetcher ?? fetch)(
    `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers,
      body: typeof options.body === "string" ? options.body : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs)
    }
  );
}
