import { describe, expect, it, vi } from "vitest";
import { parseOpenRouterProviderOrder } from "../src/config.js";
import { OpenRouterClient, sanitizeModelText, suppressRepeatedGreeting } from "../src/modules/ai-router/openrouter.js";

describe("OpenRouterClient", () => {
  it("transcribes base64 audio with the dedicated model and records usage", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: "Quero agendar uma visita amanhã.",
      model: "openai/gpt-4o-mini-transcribe",
      usage: { input_tokens: 83, output_tokens: 12, cost: 0.0005 }
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-generation-id": "gen-audio-1" }
    }));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000,
      OPENROUTER_TRANSCRIPTION_MODEL: "openai/gpt-4o-mini-transcribe",
      AUDIO_TRANSCRIPTION_MAX_BYTES: 25 * 1024 * 1024
    } as never, fetcher);

    await expect(client.transcribe({
      audioBase64: "data:audio/ogg;base64,T2dnUw==",
      format: "ogg",
      apiKey: "tenant-secret",
      language: "pt",
      prompt: "Vocabulário esperado: Newave; Plano Mútuo MEDC",
      onUsage
    })).resolves.toEqual({
      text: "Quero agendar uma visita amanhã.",
      inputTokens: 83,
      outputTokens: 12,
      costUsd: 0.0005
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      model: "openai/gpt-4o-mini-transcribe",
      input_audio: { data: "T2dnUw==", format: "ogg" },
      language: "pt",
      prompt: "Vocabulário esperado: Newave; Plano Mútuo MEDC"
    });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      providerRequestId: "gen-audio-1",
      model: "openai/gpt-4o-mini-transcribe",
      inputTokens: 83,
      outputTokens: 12,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0.0005
    }));
  });

  it("sends configured model/context and returns usage", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Resposta" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.002 }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);
    await expect(client.complete({ model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [{ role: "user", content: "Oi" }] }))
      .resolves.toEqual({ text: "Resposta", inputTokens: 10, outputTokens: 4, costUsd: 0.002 });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "provider/model", temperature: 0.4, max_tokens: 512, messages: [{ role: "system", content: "Ajude" }, { role: "user", content: "Oi" }] });
    expect(body).not.toHaveProperty("provider");
  });

  it("keeps the Anthropic prompt cacheable and records a complete per-request trace", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "gen-cache-1",
      model: "anthropic/claude-haiku-4.5",
      choices: [{ message: { content: "Resposta" } }],
      usage: {
        prompt_tokens: 5200,
        completion_tokens: 30,
        cost: 0.004,
        prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 3 }
      }
    }));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await client.complete({
      model: "anthropic/claude-haiku-4.5",
      systemPrompt: "Política estável do agente",
      systemContext: "Relógio atual: 2026-08-05 17:25 America/Sao_Paulo",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Ambos" }],
      trace: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        messageId: "00000000-0000-4000-8000-000000000002",
        requestId: "00000000-0000-4000-8000-000000000003",
        processingAttempt: 2,
        reason: "inbound_reply"
      },
      onUsage
    });

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.session_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(body.messages[0]).toEqual({
      role: "system",
      content: [{
        type: "text",
        text: "Política estável do agente",
        cache_control: { type: "ephemeral" }
      }]
    });
    expect(body.messages[1]).toEqual({
      role: "system",
      content: "Relógio atual: 2026-08-05 17:25 America/Sao_Paulo"
    });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      providerRequestId: "gen-cache-1",
      requestId: "00000000-0000-4000-8000-000000000003",
      processingAttempt: 2,
      providerRequestIndex: 1,
      callReason: "inbound_reply:initial",
      reasoningTokens: 3,
      cachedInputTokens: 5000,
      cacheWriteInputTokens: 200,
      inputTokens: 5200,
      outputTokens: 30,
      costUsd: 0.004
    }));
  });

  it("reports cost provenance from the payload: explicit zero is reported, absent cost is not", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Zero" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Ausente" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      }));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);
    const call = () => client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0, maxTokens: 512,
      apiKey: "test-key", history: [{ role: "user", content: "Oi" }], onUsage
    });
    await call();
    await call();
    // cost 0 in the payload is a real reported zero; absent cost falls back to 0 but is unreported
    expect(onUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ costUsd: 0, costReported: true }));
    expect(onUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ costUsd: 0, costReported: false }));
  });

  it("forwards an optional strict JSON schema response format", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" } }]
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: {
        name: "safe_result",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } }
        }
      }
    };

    await client.complete({
      model: "provider/model",
      systemPrompt: "Responda JSON",
      temperature: 0,
      maxTokens: 128,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Avalie" }],
      responseFormat
    });

    expect(JSON.parse(fetcher.mock.calls[0][1].body).response_format).toEqual(responseFormat);
  });

  it("sends the configured reasoning effort to compatible models", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { content: "Resposta pensada" } }]
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await client.complete({
      model: "openai/gpt-5-mini", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 1024,
      reasoningEffort: "medium", apiKey: "tenant-secret", history: [{ role: "user", content: "Oi" }]
    });

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      reasoning: { effort: "medium", exclude: true }
    });
  });

  it.each([
    ["image", "image/jpeg", "foto.jpg", "image_url"],
    ["document", "application/pdf", "contrato.pdf", "file"]
  ] as const)("analyzes %s media through a multimodal completion", async (mediaType, mimeType, fileName, contentType) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "gen-media-1", model: "openai/gpt-5-mini",
      choices: [{ message: { content: "Conteúdo analisado." } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.002 }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1", OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000, OPENROUTER_ALLOW_FALLBACKS: true
    } as never, fetcher);

    await expect(client.analyzeMedia({
      model: "openai/gpt-5-mini", mediaType, base64: "bWlkaWE=", mimeType, fileName,
      caption: "Analise", apiKey: "tenant-secret", onUsage
    })).resolves.toEqual({ text: "Conteúdo analisado.", inputTokens: 20, outputTokens: 5, costUsd: 0.002 });

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.model).toBe("openai/gpt-5-mini");
    expect(body.messages[0].content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Analise") });
    expect(body.messages[0].content[1].type).toBe(contentType);
    if (mediaType === "document") expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: "gen-media-1", inputTokens: 20, outputTokens: 5 }));
  });

  it("asks vision for a sticker's conversational intent without narrating it", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "gen-sticker-1", model: "openai/gpt-5-mini",
      choices: [{ message: { content: "Tom de comemoração." } }]
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1", OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await client.analyzeMedia({
      model: "openai/gpt-5-mini", mediaType: "image", mediaIsSticker: true,
      base64: "UklGRg==", mimeType: "image/webp", apiKey: "tenant-secret"
    });

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.messages[0].content[0].text).toMatch(/intenção provável/iu);
    expect(body.messages[0].content[0].text).toMatch(/não narre a imagem/iu);
  });

  it("forwards plugins (web search) to the request payload when provided", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: "O Samsung Galaxy S26 Pro existe, lançado em 2026." } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await client.complete({
      model: "provider/model", systemPrompt: "Verifique", temperature: 0, maxTokens: 300, apiKey: "tenant-secret",
      history: [{ role: "user", content: "O modelo \"Samsung S26 Pro\" existe?" }],
      plugins: [{ id: "web", max_results: 3 }]
    });

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ plugins: [{ id: "web", max_results: 3 }] });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty("tools");
  });

  it("prioritizes configured providers and enables OpenRouter fallback", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: "Resposta" } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000,
      OPENROUTER_PROVIDER_ORDER: ["anthropic", "openai"], OPENROUTER_ALLOW_FALLBACKS: true
    } as never, fetcher);

    await client.complete({ model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] });

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      provider: { order: ["anthropic", "openai"], allow_fallbacks: true }
    });
  });

  it("limits and excludes reasoning for reasoning models", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ choices: [{ message: { content: "Resposta" } }] })));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await client.complete({ model: "openai/gpt-oss-20b", provider: "groq", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] });
    await client.complete({ model: "openai/gpt-5-mini", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] });

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      reasoning: { effort: "low", exclude: true },
      provider: { order: ["groq"] }
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
      reasoning: { effort: "low", exclude: true }
    });
  });

  it("can explicitly disable provider fallback without forcing an order", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: "Resposta" } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000,
      OPENROUTER_ALLOW_FALLBACKS: false
    } as never, fetcher);

    await client.complete({ model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] });

    expect(JSON.parse(fetcher.mock.calls[0][1].body).provider).toEqual({ allow_fallbacks: false });
  });

  it("prefers the tenant-selected provider over the global provider order", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: "Resposta" } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000,
      OPENROUTER_PROVIDER_ORDER: ["anthropic", "openai"], OPENROUTER_ALLOW_FALLBACKS: true
    } as never, fetcher);

    await client.complete({ model: "provider/model", provider: "google", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] });

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      provider: { order: ["google"], allow_fallbacks: true }
    });
  });

  it("parses and validates provider order configuration", () => {
    expect(parseOpenRouterProviderOrder(" Anthropic, OpenAI ")).toEqual(["anthropic", "openai"]);
    expect(parseOpenRouterProviderOrder('["Google", "OpenAI"]')).toEqual(["google", "openai"]);
    expect(parseOpenRouterProviderOrder("  ")).toBeUndefined();
    expect(() => parseOpenRouterProviderOrder("OpenAI, openai")).toThrow(/duplicados/i);
    expect(() => parseOpenRouterProviderOrder("not a slug")).toThrow(/slug/i);
    expect(() => parseOpenRouterProviderOrder("[invalid")).toThrow(/JSON válida/i);
  });

  it("aborts a provider request that exceeds the configured timeout", async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 10
    } as never, fetcher as typeof fetch);
    await expect(client.complete({ model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] }))
      .rejects.toThrow(/timeout|aborted/i);
  });

  it("removes internal model tokens from valid text", () => {
    expect(sanitizeModelText("<|start|><|assistant|> Olá! <|end|>")).toBe("Olá!");
  });

  it("keeps the first greeting but suppresses repeated greetings after an assistant reply", async () => {
    expect(suppressRepeatedGreeting("Oi, Arthur! Tudo bem? Como você não é CLT, podemos usar o PayJoy.")).toBe("Como você não é CLT, podemos usar o PayJoy.");
    expect(suppressRepeatedGreeting("Olá! Seguem as condições.")).toBe("Seguem as condições.");

    const fetcher = vi.fn().mockImplementation(async () => Response.json({
      choices: [{ message: { content: "Oi! Tudo bem? Podemos continuar pelo PayJoy." } }]
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);
    const common = { model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret" };

    await expect(client.complete({ ...common, history: [{ role: "user", content: "Oi" }] })).resolves.toMatchObject({ text: "Oi! Tudo bem? Podemos continuar pelo PayJoy." });
    await expect(client.complete({ ...common, history: [{ role: "assistant", content: "Olá!" }, { role: "user", content: "Quero parcelar" }] })).resolves.toMatchObject({ text: "Podemos continuar pelo PayJoy." });
  });

  it("rejects a response made only of internal model tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { content: "<|start|>" } }]
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({ model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] }))
      .rejects.toThrow("empty response");
  });

  it("rewrites a truncated final response before returning text", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "length", message: { content: "Show, massa. Deixa eu te explicar rapidinho" } }],
        usage: { prompt_tokens: 100, completion_tokens: 512, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "stop", message: { content: "Show, massa. Com esse tempo de PJ, dá para seguir pela análise. Vou te mandar o link e, se aprovar, você finaliza com a loja." } }],
        usage: { prompt_tokens: 120, completion_tokens: 35, cost: 0.002 }
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({ model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [{ role: "user", content: "12 anos*" }] }))
      .resolves.toEqual({
        text: "Show, massa. Com esse tempo de PJ, dá para seguir pela análise. Vou te mandar o link e, se aprovar, você finaliza com a loja.",
        inputTokens: 220,
        outputTokens: 547,
        costUsd: 0.003
      });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(retryBody.max_tokens).toBeGreaterThan(512);
    expect(retryBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "Show, massa. Deixa eu te explicar rapidinho" }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("resposta anterior foi cortada") })
    ]));
  });

  it("forces a short final synthesis when a form turn remains truncated after its rewrite", async () => {
    const toolDefinitions = [{
      type: "function" as const,
      function: { name: "registrar_lead", description: "d", parameters: { type: "object" as const, properties: {} } }
    }];
    const executeTool = vi.fn().mockResolvedValue(JSON.stringify({ lead: { id: "lead-1" } }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [{
          id: "register-1",
          type: "function",
          function: { name: "registrar_lead", arguments: "{}" }
        }] } }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "length", message: { content: "A Newave funciona oferecendo uma alternativa para" } }],
        usage: { prompt_tokens: 100, completion_tokens: 640, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "length", message: { content: "Vou resumir como funciona essa solução para sua empresa" } }],
        usage: { prompt_tokens: 110, completion_tokens: 1_152, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "stop", message: { content: "A Newave oferece crédito ao seu cliente após análise, criando outra forma de fechar a venda sem depender do limite do cartão." } }],
        usage: { prompt_tokens: 120, completion_tokens: 28, cost: 0.001 }
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 640, apiKey: "tenant-secret",
      history: [{ role: "user", content: "Preenchi o formulário e quero saber como funciona" }],
      tools: toolDefinitions, executeTool
    })).resolves.toEqual({
      text: "A Newave oferece crédito ao seu cliente após análise, criando outra forma de fechar a venda sem depender do limite do cartão.",
      inputTokens: 330,
      outputTokens: 1_820,
      costUsd: 0.003
    });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(executeTool).toHaveBeenCalledTimes(1);
    const finalBody = JSON.parse(fetcher.mock.calls[3][1].body);
    expect(finalBody).not.toHaveProperty("tools");
    expect(finalBody.max_tokens).toBeLessThanOrEqual(220);
    expect(finalBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "register-1" }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("até 40 palavras") })
    ]));
  });

  it("treats token-limit text without final punctuation as truncated even without finish_reason", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Deixa eu te explicar rapidinho" } }],
        usage: { prompt_tokens: 100, completion_tokens: 64, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Funciona assim: você preenche a análise, aguarda a aprovação e finaliza na loja." } }],
        usage: { prompt_tokens: 110, completion_tokens: 18, cost: 0.001 }
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({ model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 64, apiKey: "tenant-secret", history: [] }))
      .resolves.toMatchObject({ text: "Funciona assim: você preenche a análise, aguarda a aprovação e finaliza na loja." });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rewrites a final response rejected by the outbound policy before returning it", async () => {
    const invalid = "Tenho disponibilidade de reunião hoje? quais horários ficam melhores pra você?";
    const valid = "Hoje tenho às 14h e às 16h, qual fica melhor pra você?";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: invalid } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: valid } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [{ role: "user", content: "Podemos marcar" }],
      validateFinalText: (text) => text === invalid ? "Consulte a agenda e ofereça horários concretos." : undefined
    })).resolves.toMatchObject({ text: valid });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(retryBody.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: invalid },
      { role: "user", content: "Consulte a agenda e ofereça horários concretos." }
    ]));
  });

  it("stops deterministic outbound-policy failures after one bounded rewrite", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({
      id: "gen-invalid",
      choices: [{ message: { content: "Ainda sem evidência válida." } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    const completion = client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "ok" }],
      validateFinalText: () => "Não responda sem evidência."
    });

    await expect(completion).rejects.toMatchObject({
      name: "NonRetryableAiError",
      code: "policy_retry_exhausted"
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("sends the candidate reply when a presentation-only policy rule deadlocks", async () => {
    const candidate = "Oi, Bruno, tudo certo? Tenho amanhã 12:00, 13:00 ou 15:00. Qual fica melhor?";
    const fetcher = vi.fn().mockImplementation(async () => Response.json({
      id: "gen-cosmetic",
      choices: [{ message: { content: candidate } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "preenchi o formulário" }],
      validateFinalText: () => ({ correction: "Explique que é uma reunião de 15 minutinhos no Meet.", cosmetic: true })
    })).resolves.toMatchObject({ text: candidate });

    // Uma reescrita foi tentada antes de aceitar; o impasse não vira pausa técnica.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps one final-text correction available after a successful tool call", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "registrar_lead", arguments: "{}" } }] } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Resposta inválida 1" } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Resposta final segura" } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "enviei o formulário" }],
      tools: [{ type: "function", function: { name: "registrar_lead", description: "Registra", parameters: { type: "object", properties: {} } } }],
      executeTool: vi.fn().mockResolvedValue('{"sucesso":true}'),
      validateFinalText: (text) => text.startsWith("Resposta inválida") ? "Reescreva com segurança." : undefined
    })).resolves.toMatchObject({ text: "Resposta final segura" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not reset the persistent per-message budget on a queue retry", async () => {
    const fetcher = vi.fn();
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 8
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "ok" }],
      trace: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        messageId: "00000000-0000-4000-8000-000000000002",
        requestId: "00000000-0000-4000-8000-000000000003",
        processingAttempt: 3,
        reason: "inbound_reply",
        turnBudget: { providerRequests: 8, inputTokens: 70_000, outputTokens: 1_000, costUsd: 0.14 }
      }
    })).rejects.toMatchObject({
      name: "NonRetryableAiError",
      code: "provider_request_limit_exceeded"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not cap cumulative input tokens across provider calls", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "gen-large-input",
      choices: [{ message: { content: "Resposta após consultar a agenda" } }],
      usage: { prompt_tokens: 50_000, completion_tokens: 100, cost: 0.001 }
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 8,
      AI_MAX_OUTPUT_TOKENS_PER_TURN: 8_192,
      AI_MAX_COST_USD_PER_TURN: 0.15
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Consulte a agenda antes de responder",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Quais horários estão disponíveis?" }],
      trace: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        messageId: "00000000-0000-4000-8000-000000000002",
        requestId: "00000000-0000-4000-8000-000000000003",
        processingAttempt: 1,
        reason: "inbound_reply",
        turnBudget: { providerRequests: 2, inputTokens: 100_000, outputTokens: 500, costUsd: 0.01 }
      }
    })).resolves.toMatchObject({
      text: "Resposta após consultar a agenda",
      inputTokens: 50_000
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not make a billable call when a previous attempt already exhausted the cost budget", async () => {
    const fetcher = vi.fn();
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 8,
      AI_MAX_COST_USD_PER_TURN: 0.15
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "ok" }],
      trace: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        messageId: "00000000-0000-4000-8000-000000000002",
        requestId: "00000000-0000-4000-8000-000000000003",
        processingAttempt: 2,
        reason: "inbound_reply",
        turnBudget: { providerRequests: 1, inputTokens: 10_000, outputTokens: 500, costUsd: 0.15 }
      }
    })).rejects.toMatchObject({
      name: "NonRetryableAiError",
      code: "turn_budget_exceeded"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a usable completed reply even when that call crosses the cumulative output budget", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "gen-final-over-budget",
      choices: [{ message: { content: "As condições variam conforme a operação; a equipe apresenta os valores no próximo passo." } }],
      usage: { prompt_tokens: 100, completion_tokens: 120, cost: 0.001 }
    }));
    const turnBudget = { providerRequests: 5, inputTokens: 20_000, outputTokens: 8_100, costUsd: 0.02 };
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 14,
      AI_MAX_OUTPUT_TOKENS_PER_TURN: 8_192,
      AI_MAX_COST_USD_PER_TURN: 0.15
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Vocês cobram pelo serviço?" }],
      trace: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        messageId: "00000000-0000-4000-8000-000000000002",
        requestId: "00000000-0000-4000-8000-000000000003",
        processingAttempt: 1,
        reason: "inbound_reply",
        turnBudget
      }
    })).resolves.toMatchObject({
      text: "As condições variam conforme a operação; a equipe apresenta os valores no próximo passo."
    });
    expect(turnBudget).toMatchObject({ providerRequests: 6, outputTokens: 8_220 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not continue or retry internally after a billable usage journal failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "gen-untracked",
      choices: [{ message: { content: "Resposta que não pode seguir" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "ok" }],
      onUsage: vi.fn().mockRejectedValue(new Error("database unavailable"))
    })).rejects.toMatchObject({
      name: "NonRetryableAiError",
      code: "usage_persistence_failed"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies a malformed provider body as deterministic instead of retrying it", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0,
      maxTokens: 256,
      apiKey: "tenant-secret",
      history: []
    })).rejects.toMatchObject({
      name: "NonRetryableAiError",
      code: "invalid_provider_response"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("executes tool calls in a loop and returns the final text with accumulated usage", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "verificar_horarios", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue(JSON.stringify({ horarios: [{ start: "2030-01-07T09:00:00.000Z" }] }));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "verificar_horarios", arguments: "{\"unidade_id\":\"unidade-teste\",\"data\":\"2030-01-07\"}" } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Temos horário às 9h." } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.002 }
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [{ role: "user", content: "Tem horário na sexta?" }], tools: toolDefinitions, executeTool, onUsage
    })).resolves.toEqual({ text: "Temos horário às 9h.", inputTokens: 30, outputTokens: 7, costUsd: 0.003 });

    expect(executeTool).toHaveBeenCalledWith(
      "verificar_horarios",
      "{\"unidade_id\":\"unidade-teste\",\"data\":\"2030-01-07\"}",
      { providerCallId: "call-1", ordinal: 0 }
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ inputTokens: 10, outputTokens: 2, costUsd: 0.001 }));
    expect(onUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ inputTokens: 20, outputTokens: 5, costUsd: 0.002 }));
    const secondBody = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(secondBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call-1" })
    ]));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ tool_choice: "auto" });
  });

  it("executes a qualification tool call silently, without an intermediate customer-visible message", async () => {
    const toolDefinitions = [{
      type: "function" as const,
      function: {
        name: "qualificar_lead",
        description: "d",
        parameters: { type: "object" as const, properties: {} }
      }
    }];
    const events: string[] = [];
    const executeTool = vi.fn().mockImplementation(async () => {
      events.push("qualified");
      return JSON.stringify({ qualificacao_registrada: true });
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            content: "Entendi o cenário que você explicou",
            tool_calls: [{
              id: "call-qualification",
              type: "function",
              function: { name: "qualificar_lead", arguments: "{\"estrelas\":4}" }
            }]
          }
        }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Vou te mostrar os próximos horários" } }]
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0.4,
      maxTokens: 512,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Perco vendas por falta de crédito" }],
      tools: toolDefinitions,
      executeTool
    })).resolves.toMatchObject({ text: "Vou te mostrar os próximos horários" });

    // Only the tool execution happens between the two provider requests; no
    // intermediate customer-facing message is generated for a fast internal
    // tool like qualificar_lead — the caller only sees the final answer.
    expect(events).toEqual(["qualified"]);
    const secondBody = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(secondBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: "Entendi o cenário que você explicou"
      })
    ]));
  });

  it("continues silently into tool execution even when the provider omits tool-call text", async () => {
    const toolDefinitions = [{
      type: "function" as const,
      function: {
        name: "qualificar_lead",
        description: "d",
        parameters: { type: "object" as const, properties: {} }
      }
    }];
    const events: string[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call-qualification",
              type: "function",
              function: { name: "qualificar_lead", arguments: "{\"estrelas\":3}" }
            }]
          }
        }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Vamos avançar para o próximo passo" } }]
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model",
      systemPrompt: "Ajude",
      temperature: 0.4,
      maxTokens: 512,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Não temos Instagram" }],
      tools: toolDefinitions,
      executeTool: async () => {
        events.push("qualified");
        return JSON.stringify({ qualificacao_registrada: true });
      }
    })).resolves.toMatchObject({ text: "Vamos avançar para o próximo passo" });

    expect(events).toEqual(["qualified"]);
    const secondBody = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(secondBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: null
      })
    ]));
  });

  it("retries a null final response with a larger text-only budget", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "length", message: { content: null } }],
        usage: { prompt_tokens: 20, completion_tokens: 512, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "stop", message: { content: "Agora tenho uma resposta completa" } }],
        usage: { prompt_tokens: 25, completion_tokens: 8, cost: 0.001 }
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "openai/gpt-5.4-mini",
      systemPrompt: "Ajude",
      temperature: 0.4,
      maxTokens: 512,
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Continue" }]
    })).resolves.toMatchObject({ text: "Agora tenho uma resposta completa" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetcher.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(firstBody.max_tokens).toBe(512);
    expect(secondBody.max_tokens).toBeGreaterThan(512);
    expect(secondBody.messages.at(-1).content).toContain("não trouxe texto visível");
    expect(secondBody.tools).toBeUndefined();
  });

  it("can require a specific tool only on the first provider request", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "pesquisar_modelo", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue(JSON.stringify({ resultado: "não encontrado" }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "pesquisar_modelo", arguments: "{\"modelo\":\"iPhone 18 Pro Max\"}" } }] } }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Esse modelo o time da loja confirma com o estoque." } }]
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [{ role: "user", content: "18 pro max" }],
      tools: toolDefinitions, executeTool,
      toolChoice: { type: "function", function: { name: "pesquisar_modelo" } }
    });

    expect(JSON.parse(fetcher.mock.calls[0][1].body).tool_choice).toEqual({ type: "function", function: { name: "pesquisar_modelo" } });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).tool_choice).toBe("auto");
    expect(executeTool).toHaveBeenCalledWith(
      "pesquisar_modelo",
      "{\"modelo\":\"iPhone 18 Pro Max\"}",
      { providerCallId: "call-1", ordinal: 0 }
    );
  });

  it("forces a text-only final response after the tool-call iteration cap", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "consultar_unidades", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue("{}");
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json(body.tools ? {
        choices: [{ message: { content: null, tool_calls: [{ id: "call-x", type: "function", function: { name: "consultar_unidades", arguments: "{}" } }] } }]
      } : {
        choices: [{ message: { content: "Estas são as opções disponíveis." } }]
      });
    });
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    })).resolves.toMatchObject({ text: "Estas são as opções disponíveis.", toolLimitReached: true });
    expect(fetcher).toHaveBeenCalledTimes(7);
    // Every round re-requests consultar_unidades with the same (empty) arguments;
    // the per-turn tool cache reuses the first execution instead of repeating it.
    expect(executeTool).toHaveBeenCalledTimes(1);
    const finalBody = JSON.parse(fetcher.mock.calls[6][1].body);
    expect(finalBody).not.toHaveProperty("tools");
    expect(finalBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining("resposta final") })
    ]));
    expect(finalBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining("Não use [[HANDOFF]]") })
    ]));
  });

  it("reports when a reasoning model returns no final text", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({
      choices: [{ message: { content: null, reasoning: "internal reasoning" } }]
    }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({ model: "openai/gpt-oss-20b", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret", history: [] }))
      .rejects.toThrow(/no final text.*increase max tokens/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("blocks new tools once the turn enters the reserved final-synthesis budget", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "consultar_categorias", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue("{}");
    let call = 0;
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      call += 1;
      return Response.json(body.tools ? {
        choices: [{ message: { content: null, tool_calls: [{ id: `call-${call}`, type: "function", function: { name: "consultar_categorias", arguments: JSON.stringify({ n: call }) } }] } }]
      } : {
        choices: [{ message: { content: "Aqui estão as opções disponíveis." } }]
      });
    });
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 4,
      AI_RESERVED_FINAL_REQUESTS: 1
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    })).resolves.toMatchObject({ text: "Aqui estão as opções disponíveis.", toolLimitReached: true });

    expect(fetcher).toHaveBeenCalledTimes(4);
    // Only 3 operational requests were available (hard ceiling 4 minus 1 reserved
    // request); the tool-call iteration cap (6) was never reached.
    expect(executeTool).toHaveBeenCalledTimes(3);
    const finalBody = JSON.parse(fetcher.mock.calls[3][1].body);
    expect(finalBody).not.toHaveProperty("tools");
  });

  it("retries the forced final synthesis once with a shorter, tool-free prompt", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "consultar_categorias", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue("{}");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "consultar_categorias", arguments: "{}" } }] } }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "length", message: { content: "Resposta cortada sem pontuação final" } }],
        usage: { prompt_tokens: 50, completion_tokens: 512, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Aqui está o resumo direto que cabia no espaço reservado." } }]
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 3,
      AI_RESERVED_FINAL_REQUESTS: 2
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    })).resolves.toMatchObject({
      text: "Aqui está o resumo direto que cabia no espaço reservado.",
      toolLimitReached: true
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(1);
    const retryBody = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(retryBody).not.toHaveProperty("tools");
    expect(retryBody.max_tokens).toBeLessThanOrEqual(220);
    expect(retryBody.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("até 40 palavras") });
  });

  it("reports final synthesis exhaustion after both reserved attempts fail", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "consultar_categorias", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue("{}");
    const truncated = {
      choices: [{ finish_reason: "length", message: { content: "Resposta sem fechar a frase" } }],
      usage: { prompt_tokens: 20, completion_tokens: 220, cost: 0.001 }
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "consultar_categorias", arguments: "{}" } }] } }]
      }))
      .mockResolvedValueOnce(Response.json(truncated))
      .mockResolvedValueOnce(Response.json(truncated));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 3,
      AI_RESERVED_FINAL_REQUESTS: 2
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    })).rejects.toMatchObject({ name: "NonRetryableAiError", code: "final_synthesis_exhausted" });

    // This remains distinguishable from a persisted hard-ceiling exhaustion so
    // the caller can still attempt its compact customer-visible recovery.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("does not re-execute already-completed tools during a truncation retry", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "consultar_unidades", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue(JSON.stringify({ unidades: [{ id: "u1" }] }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "consultar_unidades", arguments: "{}" } }] } }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "length", message: { content: "Temos a unidade certa para" } }],
        usage: { prompt_tokens: 30, completion_tokens: 512, cost: 0.001 }
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Temos a unidade certa para você, é a u1." } }]
      }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    })).resolves.toMatchObject({ text: "Temos a unidade certa para você, é a u1." });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(1);
    const retryBody = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(retryBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call-1", content: JSON.stringify({ unidades: [{ id: "u1" }] }) })
    ]));
  });

  it("reuses a cached tool result for identical (name, arguments) calls within the same turn", async () => {
    const toolDefinitions = [
      { type: "function" as const, function: { name: "consultar_categorias", description: "d", parameters: { type: "object" as const, properties: {} } } },
      { type: "function" as const, function: { name: "registrar_lead", description: "d", parameters: { type: "object" as const, properties: {} } } }
    ];
    const executeTool = vi.fn().mockImplementation(async (name: string) =>
      name === "consultar_categorias" ? JSON.stringify({ categorias: [{ id: "c1" }] }) : JSON.stringify({ sucesso: true })
    );
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [
          { id: "call-1", type: "function", function: { name: "consultar_categorias", arguments: "{}" } }
        ] } }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [
          { id: "call-2", type: "function", function: { name: "consultar_categorias", arguments: "{}" } },
          { id: "call-3", type: "function", function: { name: "registrar_lead", arguments: "{\"nome\":\"Ana\"}" } }
        ] } }]
      }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Cadastro concluído." } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    })).resolves.toMatchObject({ text: "Cadastro concluído." });

    // consultar_categorias({}) is requested twice with identical arguments;
    // registrar_lead runs once: 3 requested calls, only 2 real executions.
    expect(executeTool).toHaveBeenCalledTimes(2);
    const thirdBody = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(thirdBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call-2", content: JSON.stringify({ categorias: [{ id: "c1" }] }) })
    ]));
  });

  it("does not share the tool cache across separate turns", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "consultar_categorias", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue(JSON.stringify({ categorias: [] }));
    const makeFetcher = () => vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "consultar_categorias", arguments: "{}" } }] } }]
      }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Resposta do turno." } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, makeFetcher());

    await client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    });
    const client2 = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, makeFetcher());
    await client2.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    });

    // Each turn is a separate complete() call with its own in-memory cache, so
    // the identical tool+arguments pair executes once per turn, not once total.
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("executes independent read-only tools concurrently within one round", async () => {
    const toolDefinitions = [
      { type: "function" as const, function: { name: "consultar_categorias", description: "d", parameters: { type: "object" as const, properties: {} } } },
      { type: "function" as const, function: { name: "consultar_unidades", description: "d", parameters: { type: "object" as const, properties: {} } } }
    ];
    const events: string[] = [];
    const executeTool = vi.fn().mockImplementation(async (name: string) => {
      events.push(`${name}:start`);
      if (name === "consultar_categorias") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      events.push(`${name}:end`);
      return JSON.stringify({ ok: true, name });
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: null, tool_calls: [
          { id: "call-1", type: "function", function: { name: "consultar_categorias", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "consultar_unidades", arguments: "{}" } }
        ] } }]
      }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Aqui estão as opções." } }] }));
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    });

    // consultar_unidades starts and finishes while consultar_categorias is still
    // awaiting its own delay, proving the two independent read-only tools ran
    // concurrently instead of one waiting for the other to finish first.
    expect(events).toEqual([
      "consultar_categorias:start",
      "consultar_unidades:start",
      "consultar_unidades:end",
      "consultar_categorias:end"
    ]);
  });

  it("completes a complex eight-call turn instead of pausing at the old default limit (Juliana scenario)", async () => {
    const toolDefinitions = [{ type: "function" as const, function: { name: "consultar_categorias", description: "d", parameters: { type: "object" as const, properties: {} } } }];
    const executeTool = vi.fn().mockResolvedValue("{}");
    let textOnlyCalls = 0;
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools) {
        return Response.json({
          choices: [{ message: { content: null, tool_calls: [{ id: "call-x", type: "function", function: { name: "consultar_categorias", arguments: "{}" } }] } }]
        });
      }
      textOnlyCalls += 1;
      if (textOnlyCalls === 1) {
        return Response.json({
          choices: [{ finish_reason: "length", message: { content: "Ainda reunindo tudo o que você pediu" } }],
          usage: { prompt_tokens: 30, completion_tokens: 220, cost: 0.001 }
        });
      }
      return Response.json({ choices: [{ message: { content: "Prosseguindo com o atendimento, aqui está o resumo." } }] });
    });
    // Default config (AI_MAX_PROVIDER_REQUESTS_PER_TURN=14, AI_RESERVED_FINAL_REQUESTS=2):
    // the old default of 8 would have thrown provider_request_limit_exceeded
    // around the 8th call in this exact shape of turn.
    const client = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test", OPENROUTER_APP_NAME: "AtendON", OPENROUTER_TIMEOUT_MS: 60_000
    } as never, fetcher);

    await expect(client.complete({
      model: "provider/model", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, apiKey: "tenant-secret",
      history: [], tools: toolDefinitions, executeTool
    })).resolves.toMatchObject({
      text: "Prosseguindo com o atendimento, aqui está o resumo.",
      toolLimitReached: true
    });

    expect(fetcher).toHaveBeenCalledTimes(8);
  });
});
