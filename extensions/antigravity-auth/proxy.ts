import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { prepareAntigravityRequest, transformAntigravityResponse } from "opencode-antigravity-auth/dist/src/plugin/request.js";
import { cleanJSONSchemaForAntigravity } from "opencode-antigravity-auth/dist/src/plugin/request-helpers.js";
import { getRandomizedHeaders } from "opencode-antigravity-auth/dist/src/constants.js";
import {
  readAccounts,
  readConfig,
  refreshAccess,
  mutateAccounts,
  quotaStylesFor,
  endpointsFor,
  headersFor,
  normalizeAntigravityUserAgent,
  accountOrder,
  markAccountSuccess,
  markAccountFailure,
  resolveActualModel,
  patchedEffectiveModel,
  patchPreparedModel,
  thinkingConfig,
  sanitizeSchemaForAntigravity,
  isGeminiModel,
  CONFIG_PATH
} from "./index.js";

const PORT = parseInt(process.env.PROXY_PORT || "8080", 10);

function mapFinish(reason: string): string | null {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP") return "stop";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  return "stop";
}

function translateOpenAITools(openAITools: any[]) {
  if (!openAITools || openAITools.length === 0) return undefined;
  
  const functionDeclarations = openAITools
    .filter((t: any) => t.type === "function" && t.function)
    .map((t: any) => {
      const parameters = t.function.parameters || { type: "object", properties: {} };
      return {
        name: t.function.name,
        description: t.function.description || "",
        parameters: sanitizeSchemaForAntigravity(cleanJSONSchemaForAntigravity(parameters))
      };
    });

  if (functionDeclarations.length === 0) return undefined;
  return [{ functionDeclarations }];
}

function translateOpenAIMessages(openAIMessages: any[]) {
  const contents: any[] = [];
  let systemInstruction: any = undefined;

  for (const msg of openAIMessages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c: any) => c.text || "").join("\n") : "";
      if (text) {
        systemInstruction = { parts: [{ text }] };
      }
      continue;
    }

    const parts: any[] = [];
    const role = msg.role === "assistant" ? "model" : "user";

    if (msg.role === "tool") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || {});
      let parsedResponse: any = { output: text };
      try {
        parsedResponse = JSON.parse(text);
      } catch {}
      
      parts.push({
        functionResponse: {
          name: msg.name || "",
          response: parsedResponse,
          id: msg.tool_call_id || ""
        }
      });
      contents.push({ role: "user", parts });
      continue;
    }

    if (typeof msg.content === "string") {
      if (msg.content.trim()) {
        parts.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === "text" && item.text?.trim()) {
          parts.push({ text: item.text });
        } else if (item.type === "image_url" && item.image_url?.url) {
          const url = item.image_url.url;
          if (url.startsWith("data:")) {
            const matches = url.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
              const mimeType = matches[1];
              const data = matches[2];
              parts.push({ inlineData: { mimeType, data } });
            }
          }
        }
      }
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments || {};
        } catch {}
        parts.push({
          functionCall: {
            name: tc.function.name,
            args,
            id: tc.id
          }
        });
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return { contents, systemInstruction };
}

function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  if (handleCors(req, res)) return;

  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "gemini-3.6-flash-high", object: "model", created: 1716200000, owned_by: "google" },
        { id: "gemini-3.6-flash-medium", object: "model", created: 1716200000, owned_by: "google" },
        { id: "gemini-3.6-flash-low", object: "model", created: 1716200000, owned_by: "google" },
        { id: "gemini-3.1-pro-high", object: "model", created: 1716200000, owned_by: "google" },
        { id: "gemini-3.1-pro-low", object: "model", created: 1716200000, owned_by: "google" },
        { id: "gemini-3-flash", object: "model", created: 1716200000, owned_by: "google" },
        { id: "claude-sonnet-4-6-thinking", object: "model", created: 1716200000, owned_by: "anthropic" },
        { id: "claude-opus-4-6-thinking", object: "model", created: 1716200000, owned_by: "anthropic" },
        { id: "gpt-oss-120b-medium", object: "model", created: 1716200000, owned_by: "google" }
      ]
    }));
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/v1/responses" || req.url === "/v1/chat/responses")) {
    let bodyText = "";
    req.on("data", chunk => { bodyText += chunk; });
    req.on("end", async () => {
      try {
        console.log(`[Antigravity Proxy] Received ${req.method} ${req.url}`);
        console.log(`[Antigravity Proxy] Payload:`, bodyText);
        const payload = JSON.parse(bodyText || "{}");
        let modelId = payload.model || "gemini-3.6-flash-medium";
        if (!isGeminiModel(modelId)) {
          console.log(`[Antigravity Proxy] Normalizing model ${modelId} -> gemini-3.6-flash-medium`);
          modelId = "gemini-3.6-flash-medium";
        }
        
        let openAIMessages = payload.messages || [];
        if (!openAIMessages.length && payload.input) {
          for (const item of payload.input) {
            let role = item.role || "user";
            if (role === "developer") role = "system";
            
            let content: any = "";
            let tool_calls: any[] = undefined;
            const name = item.name;
            const tool_call_id = item.tool_call_id;

            if (typeof item.content === "string") {
              content = item.content;
            } else if (Array.isArray(item.content)) {
              const mappedContent: any[] = [];
              for (const part of item.content) {
                if (part.type === "input_text" || part.type === "text") {
                  mappedContent.push({ type: "text", text: part.text || part.input_text || "" });
                } else if (part.type === "image_url") {
                  mappedContent.push(part);
                } else if (part.type === "text_content") {
                  mappedContent.push({ type: "text", text: part.text || "" });
                }
              }
              content = mappedContent.length === 1 && mappedContent[0].type === "text" ? mappedContent[0].text : mappedContent;
            }

            if (item.tool_calls) {
              tool_calls = item.tool_calls;
            }

            openAIMessages.push({
              role,
              content,
              ...(tool_calls ? { tool_calls } : {}),
              ...(name ? { name } : {}),
              ...(tool_call_id ? { tool_call_id } : {})
            });
          }
        }

        const isStream = payload.stream === true;
        const temperature = payload.temperature;
        const maxTokens = payload.max_tokens;

        const config = await readConfig();
        const storage = await readAccounts();

        if (!storage.accounts.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "No authenticated accounts available. Run '/login antigravity' in Pi or set up accounts first." } }));
          return;
        }

        let { contents, systemInstruction } = translateOpenAIMessages(openAIMessages);
        if (payload.instructions) {
          if (systemInstruction && systemInstruction.parts?.[0]?.text) {
            systemInstruction.parts[0].text = payload.instructions + "\n" + systemInstruction.parts[0].text;
          } else {
            systemInstruction = { parts: [{ text: payload.instructions }] };
          }
        }
        const tools = translateOpenAITools(payload.tools);

        const requested = resolveActualModel(modelId);
        const generationConfig: any = {};
        if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
        if (temperature !== undefined) generationConfig.temperature = temperature;

        const tc = thinkingConfig(requested, payload.reasoning_effort || payload.reasoning);
        if (tc) generationConfig.thinkingConfig = tc;

        const geminiRequestBody = {
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
          ...(tools ? { tools, toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
        };

        const fakeInput = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requested)}:streamGenerateContent`;
        const family = isGeminiModel(modelId) ? "gemini" : "claude";

        let lastError: any;
        for (const style of quotaStylesFor(modelId, config)) {
          let isFirstAttempt = true;
          for (const accountIndex of accountOrder(storage, `${family}:${style}`, config)) {
            const account = storage.accounts[accountIndex];
            try {
              if (!isFirstAttempt) {
                await new Promise(r => setTimeout(r, 50 + Math.random() * 200));
              }
              isFirstAttempt = false;
              const access = await refreshAccess(account);
              const project = account.managedProjectId || account.projectId || "rising-fact-p41fc";
              
              for (const endpoint of endpointsFor(style)) {
                if (!config.quiet) {
                  console.log(`[Antigravity Proxy] Routing request via ${account.email} using ${style} quota on endpoint ${endpoint}`);
                }

                console.log("[Antigravity Proxy] Preparing Antigravity request...");
                const effectiveModel = patchedEffectiveModel(requested, style);
                const prepared: any = patchPreparedModel(prepareAntigravityRequest(fakeInput, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiRequestBody) }, access, project, endpoint, style, false, { claudeToolHardening: true }), effectiveModel);
                const h = new Headers(prepared.init.headers || {});
                for (const [k, v] of Object.entries(headersFor(style, modelId))) h.set(k, v);
                if (account.assignedUserAgent) h.set("User-Agent", normalizeAntigravityUserAgent(account.assignedUserAgent) || account.assignedUserAgent);
                
                console.log("[Antigravity Proxy] Sending fetch to Google sandbox endpoint...");
                const geminiRes = await fetch(prepared.request, { ...prepared.init, headers: h });
                console.log(`[Antigravity Proxy] Fetch response status: ${geminiRes.status} ${geminiRes.statusText}`);
                if (geminiRes.status === 429) {
                  await geminiRes.body?.cancel().catch(() => {});
                  await mutateAccounts((s) => {
                    const a = s.accounts.find(x => x.email === account.email);
                    if (a) {
                      a.failureCount = (a.failureCount || 0) + 1;
                      a.cooldownUntil = Date.now() + Math.min(2000 * Math.pow(2, a.failureCount - 1), 3600000);
                    }
                  });
                  lastError = new Error(`${style} quota rate limited for ${account.email}`);
                  break;
                }

                console.log("[Antigravity Proxy] Transforming response with transformAntigravityResponse...");
                const transformed = await transformAntigravityResponse(geminiRes, true, undefined, requested, project, endpoint, effectiveModel || prepared.effectiveModel, prepared.sessionId);
                console.log(`[Antigravity Proxy] Transformed response ok: ${transformed.ok}, status: ${transformed.status}`);
                if (!transformed.ok) {
                  const errorText = await transformed.text().catch(() => "");
                  console.error(`[Antigravity Proxy] Transformed response is not ok: ${errorText}`);
                  lastError = new Error(`${style} returned HTTP ${transformed.status}: ${errorText}`);
                  if (/invalid_grant|account has been deleted|unauthorized|verify your account/i.test(errorText)) {
                    await mutateAccounts((s) => markAccountFailure(s, accountIndex, 15 * 60_000));
                  }
                  if ([403, 404, 429, 500, 502, 503, 504].includes(transformed.status)) continue;
                  throw lastError;
                }

                await mutateAccounts((s) => {
                  const idx = s.accounts.findIndex(x => x.email === account.email);
                  if (idx >= 0) markAccountSuccess(s, `${family}:${style}`, idx, config);
                });

                const createdTime = Math.floor(Date.now() / 1000);
                const messageId = `chatcmpl-${randomBytes(16).toString("hex")}`;

                const isResponsesApi = req.url === "/v1/responses" || req.url === "/v1/chat/responses";

                if (isStream) {
                  res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive"
                  });

                  if (isResponsesApi) {
                    res.write(`event: response.created\ndata: ${JSON.stringify({ id: messageId, object: "response", status: "in_progress" })}\n\n`);
                  }

                  const textItemId = `item_${randomBytes(6).toString("hex")}`;
                  const toolItemId = `item_${randomBytes(6).toString("hex")}`;

                  console.log("[Antigravity Proxy] Starting stream reader loop...");
                  const reader = transformed.body!.getReader();
                  const decoder = new TextDecoder();
                  let buf = "";

                  try {
                    while (true) {
                      console.log("[Antigravity Proxy] Reading from stream...");
                      const { done, value } = await reader.read();
                      console.log(`[Antigravity Proxy] Stream read: done=${done}, chunkBytes=${value?.length || 0}`);
                      if (done) break;
                      buf += decoder.decode(value, { stream: true });
                      let idx;
                      while ((idx = buf.indexOf("\n")) >= 0) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (!line.startsWith("data:")) continue;
                        const data = line.slice(5).trim();
                        if (!data || data === "[DONE]") continue;
                        
                        const geminiChunk = JSON.parse(data);
                        console.log(`[Antigravity Proxy] Processing SSE chunk: ${data.slice(0, 150)}...`);
                        const candidate = geminiChunk.candidates?.[0];
                        const parts = candidate?.content?.parts || [];
                        const finishReason = candidate?.finishReason ? mapFinish(candidate.finishReason) : null;
                        
                        for (const part of parts) {
                          if (isResponsesApi) {
                            if (part.text !== undefined) {
                              res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
                                response_id: messageId,
                                item_id: textItemId,
                                output_index: 0,
                                content_index: 0,
                                delta: part.text
                              })}\n\n`);
                            }
                            if (part.functionCall) {
                              const callId = part.functionCall.id || `call_${randomBytes(6).toString("hex")}`;
                              res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
                                response_id: messageId,
                                item_id: toolItemId,
                                output_index: 0,
                                content_index: 0,
                                call_id: callId,
                                name: part.functionCall.name,
                                delta: JSON.stringify(part.functionCall.args || {})
                              })}\n\n`);
                            }
                          } else {
                            const delta: any = {};
                            if (part.text !== undefined) {
                              if (part.thought === true) {
                                delta.reasoning_content = part.text;
                              } else {
                                delta.content = part.text;
                              }
                            }
                            if (part.functionCall) {
                              delta.tool_calls = [{
                                index: 0,
                                id: part.functionCall.id || `call_${randomBytes(6).toString("hex")}`,
                                type: "function",
                                function: {
                                  name: part.functionCall.name,
                                  arguments: JSON.stringify(part.functionCall.args || {})
                                }
                              }];
                            }
                            
                            const chunkPayload = {
                              id: messageId,
                              object: "chat.completion.chunk",
                              created: createdTime,
                              model: modelId,
                              choices: [{
                                index: 0,
                                delta,
                                finish_reason: finishReason
                              }]
                            };
                            res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
                          }
                        }

                        if (parts.length === 0 && finishReason && !isResponsesApi) {
                          const chunkPayload = {
                            id: messageId,
                            object: "chat.completion.chunk",
                            created: createdTime,
                            model: modelId,
                            choices: [{
                              index: 0,
                              delta: {},
                              finish_reason: finishReason
                            }]
                          };
                          res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
                        }
                      }
                    }
                  } catch (streamErr) {
                    console.error("[Antigravity Proxy] Stream read error:", streamErr);
                  } finally {
                    if (isResponsesApi) {
                      res.write(`event: response.completed\ndata: ${JSON.stringify({
                        id: messageId,
                        object: "response",
                        status: "completed",
                        usage: {
                          prompt_tokens: 100,
                          completion_tokens: 50,
                          total_tokens: 150
                        }
                      })}\n\n`);
                    } else {
                      res.write("data: [DONE]\n\n");
                    }
                    res.end();
                  }
                  return;
                } else {
                  // Non-streaming accumulation
                  const geminiResponseText = await transformed.text();
                  const lines = geminiResponseText.split("\n");
                  let fullContent = "";
                  let fullReasoning = "";
                  const toolCalls: any[] = [];
                  let finishReason = "stop";

                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;
                    const data = trimmed.slice(5).trim();
                    if (!data || data === "[DONE]") continue;
                    try {
                      const chunk = JSON.parse(data);
                      const candidate = chunk.candidates?.[0];
                      if (candidate?.finishReason) {
                        finishReason = mapFinish(candidate.finishReason) || "stop";
                      }
                      for (const part of candidate?.content?.parts || []) {
                        if (part.text !== undefined) {
                          if (part.thought === true) {
                            fullReasoning += part.text;
                          } else {
                            fullContent += part.text;
                          }
                        }
                        if (part.functionCall) {
                          toolCalls.push({
                            id: part.functionCall.id || `call_${randomBytes(6).toString("hex")}`,
                            type: "function",
                            function: {
                              name: part.functionCall.name,
                              arguments: JSON.stringify(part.functionCall.args || {})
                            }
                          });
                        }
                      }
                    } catch {}
                  }

                  if (isResponsesApi) {
                    const output: any[] = [];
                    if (fullContent) {
                      output.push({
                        id: `item_${randomBytes(6).toString("hex")}`,
                        object: "realtime.item",
                        type: "message",
                        status: "completed",
                        role: "assistant",
                        content: [
                          {
                            type: "text",
                            text: fullContent
                          }
                        ]
                      });
                    }
                    for (const tc of toolCalls) {
                      output.push({
                        id: tc.id,
                        object: "realtime.item",
                        type: "function_call",
                        status: "completed",
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments
                      });
                    }

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                      id: messageId,
                      object: "response",
                      status: "completed",
                      output,
                      usage: {
                        prompt_tokens: 100,
                        completion_tokens: 50,
                        total_tokens: 150
                      }
                    }));
                  } else {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                      id: messageId,
                      object: "chat.completion",
                      created: createdTime,
                      model: modelId,
                      choices: [{
                        index: 0,
                        message: {
                          role: "assistant",
                          content: fullContent || null,
                          ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
                          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
                        },
                        finish_reason: toolCalls.length ? "tool_calls" : finishReason
                      }],
                      usage: {
                        prompt_tokens: 100,
                        completion_tokens: 50,
                        total_tokens: 150
                      }
                    }));
                  }
                  return;
                }
              }
            } catch (e) {
              lastError = e;
              const message = e instanceof Error ? e.message : String(e);
              if (/invalid_grant|account has been deleted|unauthorized|verify your account/i.test(message)) {
                await mutateAccounts((s) => markAccountFailure(s, accountIndex, 30 * 60_000));
              }
            }
          }
        }
        const now = Date.now();
        const healthyAccounts = storage.accounts.filter(a => !a.cooldownUntil || a.cooldownUntil < now);
        if (storage.accounts.length > 0 && healthyAccounts.length === 0) {
          throw new Error("All accounts are currently in rate-limit cooldown. Please wait a few seconds for limits to clear.");
        }
        throw lastError || new Error("All accounts and quotas failed to resolve request");
      } catch (err: any) {
        console.error("[Antigravity Proxy] Error processing completions request:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Route not found: ${req.method} ${req.url}` } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Antigravity Proxy] Listening on http://localhost:${PORT}`);
  console.log(`[Antigravity Proxy] Target config file: ${CONFIG_PATH}`);
  console.log(`[Antigravity Proxy] OpenAI-compatible endpoint: http://localhost:${PORT}/v1/chat/completions`);
});
