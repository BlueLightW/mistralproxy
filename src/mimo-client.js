import http from "node:http";
import { upstream, SERVER_AUTH } from "./config.js";
import { accountPool } from './account-pool.js';
import crypto from 'node:crypto';
import { LeChatStreamParser } from './lechat-parser.js';
import { 
    injectToolsIntoPrompt, 
    extractToolCallsFromText, 
    removeToolCallsFromText,
    detectFakeToolCalls
} from './mistral-tool-handler.js';
// import { buildToolsSystemPrompt, extractToolCalls, removeToolCallsFromText, detectFakeToolCalls } from './tool-handler.js';

// Cache de conversationId por API key/usuário
const conversationCache = new Map();

function getConversationId(apiKey) {
    if (!conversationCache.has(apiKey)) {
        conversationCache.set(apiKey, crypto.randomUUID());
    }
    return conversationCache.get(apiKey);
}

function buildQuery(messages, tools = null, toolChoice = 'auto') {
    const userMessages = (messages || []).filter(m => m.role === 'user');
    if (userMessages.length === 0) return '';
    
    const lastMessage = userMessages[userMessages.length - 1];
    
    let query = '';
    if (typeof lastMessage.content === 'string') {
        query = lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
        query = lastMessage.content
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n');
    } else {
        query = String(lastMessage.content || '');
    }
    
    // Se há tools, adiciona instruções no início da query
    if (tools && tools.length > 0) {
        const toolsPrompt = buildToolsSystemPrompt(tools, toolChoice);
        return `${toolsPrompt}\n\nUser Query: ${query}`;
    }
    
    return `Responda em português brasileiro.\n\nPergunta do usuário: ${query}`;
}
function extractSystemPrompt(messages) {
    const systemMessages = (messages || []).filter(m => m.role === 'system');
    if (systemMessages.length === 0) return '';
    
    return systemMessages
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('\n\n');
}

export async function fetchMimo(response, requestData) {
     console.log('[MiMo Request] Model:', requestData.model);
    console.log('[MiMo Request] Stream:', requestData.stream);
    console.log('[MiMo Request] Tools count:', requestData.tools?.length || 0);
    if (requestData.tools?.length > 0) {
        console.log('[MiMo Request] Tool names:', requestData.tools.map(t => t.function?.name).join(', '));
    }
    console.log('[MiMo Request] Messages count:', requestData.messages?.length || 0);
    
    const { accountManager } = await import('./account-manager.js');
    
    const account = accountManager.accounts[0];
    if (!account) throw new Error('Nenhuma conta cadastrada');
    
    const session = await accountManager.getOrCreateSession(account);
    
    // Valida se a sessão ainda está logada (verifica se o campo de chat está visível)
    const isLoggedIn = await session.page.evaluate(() => {
        return document.querySelector('div.ProseMirror[contenteditable="true"]') !== null;
    }).catch(() => false);
    
    if (!isLoggedIn) {
        console.log('[MiMo] Sessão expirada, reiniciando login...');
        // Força recriação da sessão
        accountManager.releaseSession(session.sessionId);
        const newSession = await accountManager.getOrCreateSession(account);
        session.page = newSession.page;
        session.browser = newSession.browser;
        session.context = newSession.context;
    }
    
    const tools = requestData.tools || null;
    const toolChoice = requestData.tool_choice || 'auto';
    
    // Constrói query com suporte a tools
    const queryStr = buildQuery(requestData.messages, tools, toolChoice);
    const conversationId = getConversationId(`${requestData.model}_${Date.now().toString().slice(0, -4)}`);
    
    // Extrai componentes da mensagem
    
    const systemPrompt = extractSystemPrompt(requestData.messages);
    
    // Combina system prompt + query no campo query (formato aceito pelo MiMo Web)
    const fullQuery = systemPrompt ? `${systemPrompt}\n\nUser: ${queryStr}` : queryStr;
    
    // Usa conversationId persistente baseado no model + timestamp (para manter contexto)
    
    if (requestData.stream) {
        response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        let queue = [];
        let resolver = null;
        
        const funcName = `__sendChunk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await session.page.exposeFunction(funcName, (chunk) => {
            queue.push(chunk);
            if (resolver) { resolver(); resolver = null; }
            return Promise.resolve();
        });

        if (!session.page.url().includes("chat.mistral.ai")) {
            await session.page.goto("https://chat.mistral.ai/", { waitUntil: "domcontentloaded" });
            await session.page.waitForTimeout(1000);
        }

        const evalPromise = session.page.evaluate(async ({ body, funcName, fullQuery, conversationId }) => {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 120000);
                
                console.log('[MiMo Request] Model:', body.model);
                console.log('[MiMo Request] Query length:', fullQuery.length);
                console.log('[MiMo Request] ConversationId:', conversationId);
                const messagesWithTools = injectToolsIntoPrompt(
                    body.messages, 
                    body.tools, 
                    body.tool_choice
                );
                // Gera messageId único para cada requisição
                const messageId = crypto.randomUUID();
                
                const res = await fetch('https://chat.mistral.ai/api/chat', {
                    signal: controller.signal,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    body: JSON.stringify({
                        "messages": messagesWithTools,
                        "chatId": "8457c662-ad03-42f5-8309-69f3e3611583",
                        "mode": "append",
                        "messageInput": [{
                            "type": "text",
                            "text": fullQuery
                        }],
                        "messageFiles": [],
                        "messageId": messageId,
                        "features": ["beta-code-interpreter", "beta-imagegen", "beta-trampoline", "beta-websearch", "agentic-harness"],
                        "libraries": [],
                        "integrations": [],
                        "modelConfig": {
                            "model_alias": "glm-5-latest-short",
                            "reasoning_effort": "low"
                        },
                        "disabledFeatures": [],
                        "reviewComments": [],
                        "preventFeaturesAndIntegrationsPersistence": false,
                        "transcriptionsMetadata": [],
                        "clientPromptData": {
                            "currentDate": "2026-11-10",
                            "userTimezone": "T-03:00 (America/Sao_Paulo)"
                        },
                        "stableAnonymousIdentifier": "8mka7l",
                        "supportedTaskCallbacks": ["ask_user_question", "ask_user_confirmation", "ask_enable_skill", "enable_connector", "reconnect_connector", "ask_retry_or_continue_rate_limit", "collect_workflow_input", "delegate_workflow_execution"]
                    }),
                });

                if (!res.ok) throw new Error("HTTP " + res.status);

               // No browser (evaluate): apenas repassa bytes crus
const reader = res.body.getReader();
const decoder = new TextDecoder();
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await window[funcName](decoder.decode(value, { stream: true })); // texto BRUTO
}
await window[funcName](null);

if (!sentDone) {
    await window[funcName]('data: [DONE]\n\n');
}
                
                clearTimeout(timeout);
                await window[funcName](null);
            } catch (e) {
                console.error('[MiMo Error]', e.message);
                await window[funcName]('data: ' + JSON.stringify({
                    error: { message: e.message, type: 'proxy_error' }
                }) + '\n\n');
                await window[funcName](null);
            }
        }, { body: requestData, funcName, fullQuery, conversationId });

        let evalError = null;
        evalPromise.catch(e => { 
            evalError = e; 
            console.error('[Node] Browser evaluate error:', e.message);
            if (resolver) resolver(); 
        });

        const streamTimeout = setTimeout(() => {
            if (!response.headersSent) {
                response.writeHead(504, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: "Stream timeout" }));
            } else {
                response.end();
            }
        }, 300000);

        try {
            const parser = new LeChatStreamParser();

while (true) {
    if (queue.length === 0) await new Promise(r => { resolver = r; });
    if (evalError) throw evalError;
    const raw = queue.shift();
    if (raw === null) break;
    
    for (const evt of parser.feed(raw)) {
                if (evt.type === 'content' && !hasToolCalls) {
                    response.write('data: ' + JSON.stringify({
                        choices: [{ delta: { content: evt.delta } }]
                    }) + '\n\n');
                } else if (evt.type === 'reasoning') {
                    response.write('data: ' + JSON.stringify({
                        choices: [{ delta: { reasoning_content: evt.delta } }]
                    }) + '\n\n');
                } else if (evt.type === 'tool_call') {
                    hasToolCalls = true;
                    response.write('data: ' + JSON.stringify({
                        choices: [{ delta: { tool_calls: [evt.data] } }]
                    }) + '\n\n');
                } else if (evt.type === 'final_content') {
                    // Só envia texto final se não houve tool calls
                    if (!hasToolCalls && evt.text) {
                        response.write('data: ' + JSON.stringify({
                            choices: [{ delta: { content: evt.text } }]
                        }) + '\n\n');
                    }
                } else if (evt.type === 'finish') {
                    response.write('data: [DONE]\n\n');
                }
            }
}
if (!response.writableEnded) {
    response.write('data: [DONE]\n\n');
    response.end();
}
            await evalPromise;
            clearTimeout(streamTimeout);
            response.end();
        } catch (e) {
            console.error('[Node] Stream error:', e.message);
            clearTimeout(streamTimeout);
            if (!response.headersSent) {
                response.writeHead(500, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: e.message }));
            } else {
                response.end();
            }
        }
        return null;
    }

    // --- NÃO STREAMING ---
    const messageId = crypto.randomUUID();
    const result = await session.page.evaluate(async ({ body, fullQuery, conversationId, messageId }) => {
        try {
            const res = await fetch('https://chat.mistral.ai/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    "chatId": "8457c662-ad03-42f5-8309-69f3e3611583",
                    "mode": "append",
                    "messageInput": [{
                        "type": "text",
                        "text": fullQuery
                    }],
                    "messageFiles": [],
                    "messageId": messageId,
                    "features": ["beta-code-interpreter", "beta-imagegen", "beta-trampoline", "beta-websearch", "agentic-harness"],
                    "libraries": [],
                    "integrations": [],
                    "modelConfig": {
                        "model_alias": "glm-5-latest-short",
                        "reasoning_effort": "low"
                    },
                    "disabledFeatures": [],
                    "reviewComments": [],
                    "preventFeaturesAndIntegrationsPersistence": false,
                    "transcriptionsMetadata": [],
                    "clientPromptData": {
                        "currentDate": "2026-11-10",
                        "userTimezone": "T-03:00 (America/Sao_Paulo)"
                    },
                    "stableAnonymousIdentifier": "8mka7l",
                    "supportedTaskCallbacks": ["ask_user_question", "ask_user_confirmation", "ask_enable_skill", "enable_connector", "reconnect_connector", "ask_retry_or_continue_rate_limit", "collect_workflow_input", "delegate_workflow_execution"]
                }),
            });
            
            const text = await res.text();
            let fullContent = '';
            const lines = text.split('\n');
            
            for (let line of lines) {
                line = line.trim();
                if (line.startsWith('data:')) {
                    const dataStr = line.slice(5).trim();
                    if (dataStr === '[DONE]') continue;
                    
                    try {
                        const j = JSON.parse(dataStr);
                        if (j.content && j.content.length >= 3 && !/^\d+$/.test(j.content)) {
                            fullContent += j.content;
                        }
                    } catch {}
                }
            }
            
            return { status: res.status, text: fullContent };
        } catch (e) {
            return { status: 0, text: e.message };
        }
    }, { body: requestData, fullQuery, conversationId, messageId });

    // Validação de erro (Node.js, fora do evaluate)
    if (result.status < 200 || result.status >= 300) {
        throw new Error('MiMo retornou erro: ' + result.text);
    }
// Após receber o texto completo do Mistral (não-streaming):
const fullText = result.text;

// Extrai tool calls
const toolCalls = extractToolCallsFromText(fullText);
const cleanText = removeToolCallsFromText(fullText);

console.log('[Mistral] Raw text length:', fullText.length);
console.log('[Mistral] Tool calls found:', toolCalls.length);

// Detecta "fake tool calls"
const fakeDetection = detectFakeToolCalls(fullText, requestData.tools);
if (fakeDetection.fake) {
    console.warn('[Mistral] ⚠️', fakeDetection.hint);
}

// Retorna no formato OpenAI
if (toolCalls.length > 0) {
    return {
        choices: [{
            message: {
                role: 'assistant',
                content: cleanText || null,
                tool_calls: toolCalls
            },
            finish_reason: 'tool_calls'
        }]
    };
}

// Se mencionou tools mas não chamou, adiciona aviso
if (fakeDetection.fake && requestData.tools?.length > 0) {
    const hint = `\n\n---\n\n⚠️ **Nota**: O Mistral (via Le Chat) NÃO suporta tool calls nativos via API web. Para tarefas que requerem acesso a arquivos ou execução de comandos, considere usar um modelo local (llama.cpp) ou a API oficial da Mistral.`;
    return {
        choices: [{
            message: {
                role: 'assistant',
                content: cleanText + hint
            },
            finish_reason: 'stop'
        }]
    };
}

// Caso normal
return {
    choices: [{
        message: {
            role: 'assistant',
            content: cleanText
        },
        finish_reason: 'stop'
    }]
};}
export const agent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    noDelay: true,
    maxSockets: 64,
    maxFreeSockets: 16,
});

export function serverHeaders(extra = {}) {
    const h = { ...extra, host: upstream.host };
    if (SERVER_AUTH) h["authorization"] = SERVER_AUTH;
    return h;
}

export function serverReq(method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(
            {
                method,
                hostname: upstream.hostname,
                port: upstream.port,
                path,
                agent,
                headers: serverHeaders({
                    "content-type": "application/json",
                    ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
                    ...headers,
                }),
                timeout: 120000,
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    let json;
                    try {
                        json = raw ? JSON.parse(raw) : null;
                    } catch {
                        json = null;
                    }
                    resolve({ status: res.statusCode, json, raw });
                });
            },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

export function openMiMoEvents(onEvent, onError) {
    let activeReq = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimeout = null;

    function connect() {
        if (closed) return;
        activeReq = http.request(
            {
                method: "GET",
                hostname: upstream.hostname,
                port: upstream.port,
                path: "/event",
                agent,
                headers: serverHeaders({ accept: "text/event-stream" }),
                timeout: 0,
            },
            (res) => {
                attempt = 0;
                let buf = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    buf += chunk;
                    if (buf.length > 1_000_000) {
                        res.destroy();
                        handleFailure(new Error("SSE buffer overflow"));
                        return;
                    }
                    let idx;
                    while ((idx = buf.indexOf("\n\n")) >= 0) {
                        const raw = buf.slice(0, idx);
                        buf = buf.slice(idx + 2);
                        const dataLine = raw
                            .split("\n")
                            .find((l) => l.startsWith("data:"));
                        if (!dataLine) continue;
                        try {
                            onEvent(JSON.parse(dataLine.slice(5).trim()));
                        } catch {
                            // ignora
                        }
                    }
                });
                res.on("end", () => handleFailure(new Error("event stream ended")));
                res.on("error", (e) => handleFailure(e));
            },
        );
        activeReq.on("error", (e) => handleFailure(e));
        activeReq.end();
    }

    function handleFailure(err) {
        if (closed) return;
        activeReq = null;
        attempt++;
        if (attempt > 5) {
            if (onError) onError(err);
            return;
        }
        const delay = 100 * Math.pow(2, attempt - 1);
        reconnectTimeout = setTimeout(connect, delay);
    }

    connect();

    return {
        close() {
            closed = true;
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            if (activeReq) activeReq.destroy();
        },
    };
}