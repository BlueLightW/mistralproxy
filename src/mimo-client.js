import { extractToolCalls, removeToolCallsFromText, detectFakeToolCalls } from './tool-handler.js';
import { LeChatStreamParser } from './lechat-parser.js';
import http from 'node:http';
import { upstream, SERVER_AUTH } from './config.js';

function getConversationId(base) {
    return `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractSystemPrompt(messages) {
    for (const m of messages) {
        if (m.role === 'system' && typeof m.content === 'string') {
            return m.content;
        }
    }
    return null;
}

function buildQuery(messages, tools, toolChoice) {
    const filtered = messages.filter(m => m.role !== 'system');
    
    if (tools && tools.length > 0) {
        const toolDescs = tools.map(t => {
            const fn = t.function;
            return `- ${fn.name}: ${fn.description}\n  Parâmetros: ${JSON.stringify(fn.parameters)}`;
        }).join('\n');
        
        const toolChoiceDesc = toolChoice === 'required' ? ' (obrigatório)' : toolChoice === 'none' ? ' (não usar)' : '';
        
        return `Ferramentas disponíveis${toolChoiceDesc}:\n${toolDescs}\n\nMensagens:\n${filtered.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n')}`;
    }
    
    return filtered
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('\n\n');
}

// New fetchMimo function - complete rewrite
export async function fetchMimo(response, requestData) {
    console.log('[MiMo] >>> fetchMimo START');
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
    
    console.log('[MiMo] Getting session...');
    let session = await accountManager.getOrCreateSession(account);
    console.log('[MiMo] Got session:', session.sessionId);
    
    // Verifica se o browser/página ainda estão válidos
    const browser = session.browser?.browser?.();
    const isBrowserValid = browser && browser.isConnected();
    const isPageValid = session.page && !session.page.isClosed();
    
    if (!isBrowserValid || !isPageValid) {
        console.log('[MiMo] Browser/page inválido, recriando sessão...');
        accountManager.releaseSession(session.sessionId);
        session = await accountManager.getOrCreateSession(account);
        console.log('[MiMo] Nova sessão:', session.sessionId);
    }
    
    // Valida se a sessão ainda está logada
    console.log('[MiMo] Checking if logged in...');
    let isLoggedIn = false;
    try {
        isLoggedIn = await session.page.evaluate(() => {
            return document.querySelector('div.ProseMirror[contenteditable="true"]') !== null;
        });
    } catch (e) {
        console.log('[MiMo] Erro ao verificar login, assumindo não logado:', e.message);
        isLoggedIn = false;
    }
    
    console.log('[MiMo] isLoggedIn:', isLoggedIn);
    
    if (!isLoggedIn) {
        console.log('[MiMo] Sessão expirada, reiniciando login...');
        accountManager.releaseSession(session.sessionId);
        session = await accountManager.getOrCreateSession(account);
        console.log('[MiMo] Nova sessão após re-login:', session.sessionId);
    }
    
    // Listener para detectar se browser/page fecha
    session.page.on('close', () => {
        console.log('[MiMo] Página fechada, liberando sessão');
        accountManager.releaseSession(session.sessionId);
    });
    if (browser) {
        browser.on('disconnected', () => {
            console.log('[MiMo] Browser desconectado, liberando sessão');
            accountManager.releaseSession(session.sessionId);
        });
    }
    
    // Capturar logs do browser
    session.page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'log' || type === 'error' || type === 'warning') {
            console.log(`[Browser] ${text}`);
        }
    });
    session.page.on('pageerror', err => {
        console.error('[Browser Page Error]', err.message);
    });

    const tools = requestData.tools || null;
    const toolChoice = requestData.tool_choice || 'auto';
    
    // Constrói query com suporte a tools
    const queryStr = buildQuery(requestData.messages, tools, toolChoice);
    const conversationId = getConversationId(`${requestData.model}_${Date.now().toString().slice(0, -4)}`);
    
    // Extrai componentes da mensagem
    const systemPrompt = extractSystemPrompt(requestData.messages);
    const fullQuery = systemPrompt ? `${systemPrompt}\n\nUser: ${queryStr}` : queryStr;
    
    // ----------------------------------------
    // STREAMING
    // ----------------------------------------
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
        
        // Garante que estamos na página /work para criar novo chat
        let currentUrl = session.page.url();
        console.log('[MiMo] Current URL:', currentUrl);
        
        // Se não estamos em /work, ir para lá
        if (!currentUrl.includes('chat.mistral.ai/work')) {
            console.log('[MiMo] Navegando para /work...');
            await session.page.goto("https://chat.mistral.ai/work", { waitUntil: "domcontentloaded" });
            await session.page.waitForTimeout(3000);
            currentUrl = session.page.url();
            console.log('[MiMo] Nova URL:', currentUrl);
        }
        
        // Se estamos em /work (página principal do workspace), tentar clicar "New chat"
        if (currentUrl === 'https://chat.mistral.ai/work' || currentUrl === 'https://chat.mistral.ai/work/') {
            console.log('[MiMo] Em /work, procurando botão New chat...');
            
            // Aguardar página carregar completamente
            await session.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            await session.page.waitForTimeout(3000);
            
            // Listar TODOS os elementos clicáveis para debug (botões, links, etc.)
            const clickables = await session.page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, a, [role="button"], [onclick], [href]'));
                return elements.map(el => ({
                    tag: el.tagName,
                    text: el.innerText?.trim().slice(0, 50),
                    ariaLabel: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    href: el.getAttribute('href'),
                    className: el.className?.slice(0, 100),
                    role: el.getAttribute('role')
                })).filter(e => e.text || e.ariaLabel || (e.href && !e.href.includes('/_next/') && !e.href.includes('.css') && !e.href.includes('.js') && !e.href.includes('.png')));
            });
            console.log('[MiMo] Elementos clicáveis na página /work:', JSON.stringify(clickables).slice(0, 10000));
            
            // Seletores para botão New chat
            const newChatSelectors = [
                'button[aria-label*="New chat" i]',
                'button[aria-label*="Novo chat" i]',
                'button[aria-label*="New conversation" i]',
                'button[aria-label*="Nova conversa" i]',
                'button:has-text("New chat")',
                'button:has-text("Novo chat")',
                'button:has-text("New conversation")',
                'button:has-text("Nova conversa")',
                'button:has-text("New")',
                'button:has-text("Novo")',
                'button:has-text("Novo projeto")',
                'button:has-text("Novo projeto")',
                'a[href*="/work/new"]',
                'a:has-text("Novo chat")',
                'a:has-text("New chat")',
                'a:has-text("Novo")',
                'a:has-text("New")',
                'button[data-testid="new-chat"]',
                'button[aria-label*="new" i]',
                'button[aria-label*="novo" i]',
                'button[aria-label*="projeto" i]',
                'button:has(svg.lucide-plus)',
                'button:has(svg[data-lucide="plus"])',
                '[role="button"]:has-text("New")',
                '[role="button"]:has-text("Novo")',
                'button[title*="New" i]',
                'button[title*="Novo" i]',
                // Links com texto "Novo chat" - tentar primeiro pois podem ser dropdown triggers
                'a:has-text("Novo chat")',
                'a:has-text("New chat")',
                'a:has-text("Novo")',
                'a:has-text("New")',
                'a[href*="/work/new"]',
                // Try finding plus icon buttons more broadly
                'button:has(svg)',
                '[role="button"]:has(svg)',
                'a:has(svg)',
            ];
            
            let clicked = false;
            for (const selector of newChatSelectors) {
                const btn = session.page.locator(selector).first();
                if (await btn.isVisible().catch(() => false)) {
                    console.log('[MiMo] Clicando em New chat com seletor:', selector);
                    await btn.click();
                    clicked = true;
                    // Wait longer and check for URL change or modal
                    await session.page.waitForTimeout(3000);
                    
                    // Check if a modal appeared
                    const modalVisible = await session.page.locator('[role="dialog"], .modal, [data-testid="modal"]').first().isVisible().catch(() => false);
                    if (modalVisible) {
                        console.log('[MiMo] Modal detectado após clique, tentando confirmar...');
                        // Try to find confirm/create button in modal
                        const confirmSelectors = [
                            'button:has-text("Criar")',
                            'button:has-text("Create")',
                            'button:has-text("Confirmar")',
                            'button:has-text("Confirm")',
                            'button:has-text("Novo chat")',
                            'button:has-text("New chat")',
                            'button:has-text("Iniciar")',
                            'button:has-text("Start")',
                            'button[type="submit"]',
                            'button[data-testid="confirm"]',
                            'button[data-testid="create"]',
                        ];
                        for (const confirmSel of confirmSelectors) {
                            const confirmBtn = session.page.locator(confirmSel).first();
                            if (await confirmBtn.isVisible().catch(() => false)) {
                                console.log('[MiMo] Clicando em confirmar no modal:', confirmSel);
                                await confirmBtn.click();
                                await session.page.waitForTimeout(2000);
                                break;
                            }
                        }
                    }
                    break;
                }
            }
            
            // Fallback: se não conseguiu criar novo chat, clicar no primeiro chat da sidebar (link com /work/<uuid>)
            if (!clicked) {
                console.log('[MiMo] Tentando clicar no primeiro chat da sidebar...');
                const sidebarChatLinks = await session.page.locator('a[href^="/work/"]').all();
                for (const link of sidebarChatLinks) {
                    const href = await link.getAttribute('href');
                    if (href && href.match(/\/work\/[a-f0-9-]+/)) {
                        const isVisible = await link.isVisible().catch(() => false);
                        if (isVisible) {
                            console.log('[MiMo] Clicando em chat da sidebar:', href);
                            await link.click();
                            clicked = true;
                            await session.page.waitForTimeout(2000);
                            break;
                        }
                    }
                }
            }
            
            // Verificar se URL já mudou para um chat válido
            let newUrl = session.page.url();
            console.log('[MiMo] URL atual após clique:', newUrl);
            if (newUrl.includes('/work/') && !newUrl.endsWith('/work') && !newUrl.endsWith('/work/') && !newUrl.includes('/work/temporary-chat')) {
                currentUrl = newUrl;
                console.log('[MiMo] URL de chat detectada imediatamente:', currentUrl);
            } else {
                // Aguardar URL mudar para /work/<algo> após clique (qualquer path válido de chat)
                try {
                    await session.page.waitForURL(url => url.includes('/work/') && !url.endsWith('/work') && !url.endsWith('/work/') && !url.includes('/work/temporary-chat'), { timeout: 15000 });
                    currentUrl = session.page.url();
                    console.log('[MiMo] URL após criar novo chat:', currentUrl);
                } catch (e) {
                    console.log('[MiMo] Timeout aguardando novo chat, URL atual:', session.page.url());
                }
            }
            
            // Se ainda não temos chat válido, tentar chats da sidebar
            if (!currentUrl.includes('/work/') || currentUrl === 'https://chat.mistral.ai/work' || currentUrl.includes('/work/temporary-chat')) {
                console.log('[MiMo] Tentando chats da sidebar como fallback...');
                const sidebarChatLinks = await session.page.locator('a[href^="/work/"]').all();
                for (const link of sidebarChatLinks) {
                    const href = await link.getAttribute('href');
                    if (href && href.match(/\/work\/[a-f0-9-]+/)) {
                        const isVisible = await link.isVisible().catch(() => false);
                        if (isVisible) {
                            console.log('[MiMo] Clicando em chat da sidebar (fallback):', href);
                            await link.click();
                            await session.page.waitForTimeout(2000);
                            currentUrl = session.page.url();
                            if (currentUrl.includes('/work/') && !currentUrl.endsWith('/work') && !currentUrl.endsWith('/work/') && !currentUrl.includes('/work/temporary-chat')) {
                                console.log('[MiMo] Chat da sidebar funcionou:', currentUrl);
                                break;
                            }
                        }
                    }
                }
            }
        }
        
        // Após navegar para o chat, extrair o chatId real da página (pode ser diferente do path da URL)
        console.log('[MiMo] Aguardando página do chat carregar...');
        await session.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await session.page.waitForTimeout(3000);
        
        // Tentar extrair chatId da página (localStorage, meta tags, etc.)
        const pageChatId = await session.page.evaluate(() => {
            // Tentar localStorage
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('chat') || key.includes('conversation'))) {
                    try {
                        const val = JSON.parse(localStorage.getItem(key));
                        if (val && val.id) return val.id;
                        if (val && val.chatId) return val.chatId;
                    } catch {}
                }
            }
            // Tentar meta tags
            const metaChatId = document.querySelector('meta[name="chat-id"], meta[property="chat:id"]');
            if (metaChatId) return metaChatId.getAttribute('content');
            // Tentar data attributes no body
            const bodyChatId = document.body.getAttribute('data-chat-id');
            if (bodyChatId) return bodyChatId;
            // Tentar no ProseMirror editor
            const editor = document.querySelector('div.ProseMirror[contenteditable="true"]');
            if (editor && editor.dataset.chatId) return editor.dataset.chatId;
            // Tentar encontrar no trpc cache (React Query)
            if (window.__TRPC_CLIENT__) {
                console.log('[MiMo Debug] trpc client found');
            }
            // Tentar encontrar em window.__NEXT_DATA__
            if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps) {
                const props = window.__NEXT_DATA__.props.pageProps;
                if (props.chatId) return props.chatId;
                if (props.chat && props.chat.id) return props.chat.id;
            }
            // Tentar localStorage por chaves mais específicas
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('currentChat') || key.includes('activeChat') || key.includes('selectedChat'))) {
                    try {
                        const val = JSON.parse(localStorage.getItem(key));
                        if (val && val.id) return val.id;
                        if (val && val.chatId) return val.chatId;
                        if (typeof val === 'string' && val.length > 10) return val;
                    } catch {}
                }
            }
            return null;
        });
        
        console.log('[MiMo] pageChatId evaluation result:', pageChatId);
        
        if (pageChatId) {
            console.log('[MiMo] ChatId extraído da página:', pageChatId);
            currentUrl = `https://chat.mistral.ai/work/${pageChatId}`;
        }
        
        // Se ainda não temos chat válido, extrair do localStorage
        if (!currentUrl.includes('/work/') || currentUrl === 'https://chat.mistral.ai/work') {
            console.log('[MiMo] Tentando extrair chats do localStorage...');
            
            let extractedUrl = null;
            try {
                const chatData = await session.page.evaluate(async () => {
                    const chats = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (key && (key.includes('chat') || key.includes('conversation') || key.includes('work-kv-cache'))) {
                            try {
                                chats[key] = JSON.parse(localStorage.getItem(key));
                            } catch { chats[key] = localStorage.getItem(key); }
                        }
                    }
                    for (let i = 0; i < sessionStorage.length; i++) {
                        const key = sessionStorage.key(i);
                        if (key && (key.includes('chat') || key.includes('conversation') || key.includes('work-kv-cache'))) {
                            try {
                                chats[key] = JSON.parse(sessionStorage.getItem(key));
                            } catch { chats[key] = sessionStorage.getItem(key); }
                        }
                    }
                    return chats;
                });
                
                console.log('[MiMo] Chat data from storage:', JSON.stringify(chatData).slice(0, 2000));
                
                // Extrair UUIDs das chaves do localStorage
                for (const key of Object.keys(chatData)) {
                    const uuidMatches = key.match(/\[([^\]]+)\]/);
                    if (uuidMatches) {
                        const uuids = uuidMatches[1].split(',').map(u => u.trim().replace(/"/g, ''));
                        console.log('[MiMo] UUIDs encontrados:', uuids);
                        if (uuids.length > 0) {
                            extractedUrl = `https://chat.mistral.ai/work/${uuids[0]}`;
                            console.log('[MiMo] Usando primeiro UUID:', uuids[0]);
                            break;
                        }
                    }
                }
            } catch (e) {
                console.log('[MiMo] Erro ao extrair storage:', e.message);
            }
            
            // Navegar para a URL do chat extraída
            if (extractedUrl) {
                currentUrl = extractedUrl;
                console.log('[MiMo] Navegando para chat URL:', currentUrl);
                await session.page.goto(currentUrl, { waitUntil: "domcontentloaded" });
                await session.page.waitForTimeout(2000);
                console.log('[MiMo] URL após navegação para chat:', session.page.url());
            }
        }
        
        // Determinar chatId final
        let chatId = process.env.MISTRAL_CHAT_ID;
        if (!chatId) {
            const workMatch = currentUrl.match(/\/work\/([^/?#]+)/);
            if (workMatch) {
                chatId = workMatch[1];
                console.log('[MiMo] ChatId extraído da URL:', chatId);
            } else {
                chatId = conversationId;
                console.log('[MiMo] Usando conversationId como chatId:', chatId);
            }
        }
        
        // Payload
        const payload = {
            chatId: chatId,
            mode: "append",
            messageInput: [{ type: "text", text: fullQuery }],
            messageFiles: [],
            messageId: crypto.randomUUID(),
            features: ["beta-code-interpreter", "beta-imagegen", "beta-trampoline", "beta-websearch", "agentic-harness"],
            libraries: [],
            integrations: [],
            modelConfig: { model_alias: "glm-5-latest-short", reasoning_effort: "low" },
            disabledFeatures: [],
            reviewComments: [],
            preventFeaturesAndIntegrationsPersistence: false,
            transcriptionsMetadata: [],
            clientPromptData: {
                currentDate: new Date().toISOString().slice(0, 10),
                userTimezone: "T-03:00 (America/Sao_Paulo)"
            },
            stableAnonymousIdentifier: "8mka7l",
            supportedTaskCallbacks: ["ask_user_question", "ask_user_confirmation", "ask_enable_skill", "enable_connector", "reconnect_connector", "ask_retry_or_continue_rate_limit", "collect_workflow_input", "delegate_workflow_execution"]
        };
        
        const evalPromise = session.page.evaluate(async ({ payload, funcName }) => {
            const sendChunk = globalThis[funcName];
            console.log('[Browser] >>> evaluate START');
            try {
                console.log('[Browser] Iniciando fetch para /api/chat');
                console.log('[Browser] URL atual:', window.location.href);
                console.log('[Browser] Cookies:', document.cookie);
                console.log('[Browser] Origin:', window.location.origin);
                
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 120000);
                
                const res = await fetch('https://chat.mistral.ai/api/chat', {
                    signal: controller.signal,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    body: JSON.stringify(payload),
                    credentials: 'include'
                });
                
                console.log('[Browser] Response status:', res.status);
                console.log('[Browser] Response headers:', [...res.headers.entries()]);
                
                if (!res.ok) {
                    const errText = await res.text();
                    console.error('[Browser] Error response body:', errText);
                    throw new Error('HTTP ' + res.status + ' ' + errText.slice(0, 500));
                }
                
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    sendChunk(decoder.decode(value, { stream: true }));
                }
                clearTimeout(timeout);
                sendChunk(null);
                console.log('[Browser] >>> evaluate END - success');
            } catch (e) {
                console.error('[Browser] Fetch error:', e.message);
                console.log('[Browser] >>> evaluate END - error:', e.message);
                sendChunk('ERROR:' + e.message);
                sendChunk(null);
            }
        }, { payload, funcName });
        
        console.log('[Node] page.evaluate called, waiting...');
        await new Promise(r => setTimeout(r, 100));
        console.log('[Node] after initial wait');
        
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
        
        // Parser tRPC/JSON Patch do Le Chat (lado Node)
        const parser = new LeChatStreamParser();
        let finished = false;
        
        try {
            while (true) {
                if (queue.length === 0) {
                    await new Promise((r) => { resolver = r; });
                }
                if (evalError) throw evalError;
                const raw = queue.shift();
                if (raw === null) break;
                if (typeof raw === 'string' && raw.startsWith('ERROR:')) {
                    throw new Error(raw.slice(6));
                }
                
                for (const evt of parser.feed(raw)) {
                    if (evt.type === 'content') {
                        response.write('data: ' + JSON.stringify({
                            choices: [{ delta: { content: evt.delta } }]
                        }) + '\n\n');
                    } else if (evt.type === 'reasoning') {
                        response.write('data: ' + JSON.stringify({
                            choices: [{ delta: { reasoning_content: evt.delta } }]
                        }) + '\n\n');
                    } else if (evt.type === 'finish') {
                        finished = true;
                        response.write('data: [DONE]\n\n');
                    }
                }
            }
            if (!finished) response.write('data: [DONE]\n\n');
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
    
    // ----------------------------------------
    // NON-STREAMING
    // ----------------------------------------
    const messageId = crypto.randomUUID();
    
    // Garante que estamos na página /work para criar novo chat (mesma lógica do streaming)
    let currentUrl = session.page.url();
    console.log('[MiMo Non-stream] Current URL:', currentUrl);
    
    // Se não estamos em /work, ir para lá
    if (!currentUrl.includes('chat.mistral.ai/work')) {
        console.log('[MiMo Non-stream] Navegando para /work...');
        await session.page.goto("https://chat.mistral.ai/work", { waitUntil: "domcontentloaded" });
        await session.page.waitForTimeout(3000);
        currentUrl = session.page.url();
        console.log('[MiMo Non-stream] Nova URL:', currentUrl);
    }
    
// Se estamos em /work (página principal do workspace), tentar clicar "New chat"
        if (currentUrl === 'https://chat.mistral.ai/work' || currentUrl === 'https://chat.mistral.ai/work/') {
            console.log('[MiMo Non-stream] Em /work, procurando botão New chat...');
            
            // Aguardar página carregar completamente
            await session.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            await session.page.waitForTimeout(3000);
            
            // Listar TODOS os elementos clicáveis para debug (botões, links, etc.)
            const clickables = await session.page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, a, [role="button"], [onclick], [href]'));
                return elements.map(el => ({
                    tag: el.tagName,
                    text: el.innerText?.trim().slice(0, 50),
                    ariaLabel: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    href: el.getAttribute('href'),
                    className: el.className?.slice(0, 100),
                    role: el.getAttribute('role')
                })).filter(e => e.text || e.ariaLabel || (e.href && !e.href.includes('/_next/') && !e.href.includes('.css') && !e.href.includes('.js') && !e.href.includes('.png')));
            });
            console.log('[MiMo Non-stream] Elementos clicáveis na página /work:', JSON.stringify(clickables).slice(0, 10000));
        
        // Seletores para botão New chat
        const newChatSelectors = [
            'button[aria-label*="New chat" i]',
            'button[aria-label*="Novo chat" i]',
            'button[aria-label*="New conversation" i]',
            'button[aria-label*="Nova conversa" i]',
            'button:has-text("New chat")',
            'button:has-text("Novo chat")',
            'button:has-text("New conversation")',
            'button:has-text("Nova conversa")',
            'button:has-text("New")',
            'button:has-text("Novo")',
            'button:has-text("Novo projeto")',
            'a[href*="/work/new"]',
            'a:has-text("Novo chat")',
            'a:has-text("New chat")',
            'a:has-text("Novo")',
            'a:has-text("New")',
            'button[data-testid="new-chat"]',
            'button[aria-label*="new" i]',
            'button[aria-label*="novo" i]',
            'button[aria-label*="projeto" i]',
            'button:has(svg.lucide-plus)',
            'button:has(svg[data-lucide="plus"])',
            '[role="button"]:has-text("New")',
            '[role="button"]:has-text("Novo")',
            'button[title*="New" i]',
            'button[title*="Novo" i]',
            // Try finding plus icon buttons more broadly
            'button:has(svg)',
            '[role="button"]:has(svg)',
            'a:has(svg)',
        ];
        
        let clicked = false;
        for (const selector of newChatSelectors) {
            const btn = session.page.locator(selector).first();
            if (await btn.isVisible().catch(() => false)) {
                console.log('[MiMo Non-stream] Clicando em New chat com seletor:', selector);
                await btn.click();
                clicked = true;
                // Wait longer and check for URL change or modal
                await session.page.waitForTimeout(3000);
                
                // Check if a modal appeared
                const modalVisible = await session.page.locator('[role="dialog"], .modal, [data-testid="modal"]').first().isVisible().catch(() => false);
                if (modalVisible) {
                    console.log('[MiMo Non-stream] Modal detectado após clique, tentando confirmar...');
                    // Try to find confirm/create button in modal
                    const confirmSelectors = [
                        'button:has-text("Criar")',
                        'button:has-text("Create")',
                        'button:has-text("Confirmar")',
                        'button:has-text("Confirm")',
                        'button:has-text("Novo chat")',
                        'button:has-text("New chat")',
                        'button:has-text("Iniciar")',
                        'button:has-text("Start")',
                        'button[type="submit"]',
                        'button[data-testid="confirm"]',
                        'button[data-testid="create"]',
                    ];
                    for (const confirmSel of confirmSelectors) {
                        const confirmBtn = session.page.locator(confirmSel).first();
                        if (await confirmBtn.isVisible().catch(() => false)) {
                            console.log('[MiMo Non-stream] Clicando em confirmar no modal:', confirmSel);
                            await confirmBtn.click();
                            await session.page.waitForTimeout(2000);
                            break;
                        }
                    }
                }
                break;
            }
        }
        
        // Verificar se URL já mudou para um chat válido
        let newUrl = session.page.url();
        console.log('[MiMo Non-stream] URL atual após clique:', newUrl);
        if (newUrl.includes('/work/') && !newUrl.endsWith('/work') && !newUrl.endsWith('/work/') && !newUrl.includes('/work/temporary-chat')) {
            currentUrl = newUrl;
            console.log('[MiMo Non-stream] URL de chat detectada imediatamente:', currentUrl);
        } else {
            // Aguardar URL mudar para /work/<algo> após clique (qualquer path válido de chat)
            try {
                await session.page.waitForURL(url => url.includes('/work/') && !url.endsWith('/work') && !url.endsWith('/work/') && !url.includes('/work/temporary-chat'), { timeout: 15000 });
                currentUrl = session.page.url();
                console.log('[MiMo Non-stream] URL após criar novo chat:', currentUrl);
            } catch (e) {
                console.log('[MiMo Non-stream] Timeout aguardando novo chat, URL atual:', session.page.url());
            }
        }
        
        // Se ainda não temos chat válido, tentar chats da sidebar
        if (!currentUrl.includes('/work/') || currentUrl === 'https://chat.mistral.ai/work' || currentUrl.includes('/work/temporary-chat')) {
            console.log('[MiMo Non-stream] Tentando chats da sidebar como fallback...');
            const sidebarChatLinks = await session.page.locator('a[href^="/work/"]').all();
            for (const link of sidebarChatLinks) {
                const href = await link.getAttribute('href');
                if (href && href.match(/\/work\/[a-f0-9-]+/)) {
                    const isVisible = await link.isVisible().catch(() => false);
                    if (isVisible) {
                        console.log('[MiMo Non-stream] Clicando em chat da sidebar (fallback):', href);
                        await link.click();
                        await session.page.waitForTimeout(2000);
                        currentUrl = session.page.url();
                        if (currentUrl.includes('/work/') && !currentUrl.endsWith('/work') && !currentUrl.endsWith('/work/') && !currentUrl.includes('/work/temporary-chat')) {
                            console.log('[MiMo Non-stream] Chat da sidebar funcionou:', currentUrl);
                            break;
                        }
                    }
                }
            }
        }
    
    // Após navegar para o chat, extrair o chatId real da página (pode ser diferente do path da URL)
    console.log('[MiMo Non-stream] Aguardando página do chat carregar...');
    await session.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await session.page.waitForTimeout(3000);
    
    // Tentar extrair chatId da página (localStorage, meta tags, etc.)
    const pageChatId = await session.page.evaluate(() => {
        // Tentar localStorage
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.includes('chat') || key.includes('conversation'))) {
                try {
                    const val = JSON.parse(localStorage.getItem(key));
                    if (val && val.id) return val.id;
                    if (val && val.chatId) return val.chatId;
                } catch {}
            }
        }
        // Tentar meta tags
        const metaChatId = document.querySelector('meta[name="chat-id"], meta[property="chat:id"]');
        if (metaChatId) return metaChatId.getAttribute('content');
        // Tentar data attributes no body
        const bodyChatId = document.body.getAttribute('data-chat-id');
        if (bodyChatId) return bodyChatId;
        // Tentar no ProseMirror editor
        const editor = document.querySelector('div.ProseMirror[contenteditable="true"]');
        if (editor && editor.dataset.chatId) return editor.dataset.chatId;
        // Tentar encontrar em window.__NEXT_DATA__
        if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps) {
            const props = window.__NEXT_DATA__.props.pageProps;
            if (props.chatId) return props.chatId;
            if (props.chat && props.chat.id) return props.chat.id;
        }
        // Tentar localStorage por chaves mais específicas
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.includes('currentChat') || key.includes('activeChat') || key.includes('selectedChat'))) {
                try {
                    const val = JSON.parse(localStorage.getItem(key));
                    if (val && val.id) return val.id;
                    if (val && val.chatId) return val.chatId;
                    if (typeof val === 'string' && val.length > 10) return val;
                } catch {}
            }
        }
        return null;
    });
    
    console.log('[MiMo Non-stream] pageChatId evaluation result:', pageChatId);
    
    if (pageChatId) {
        console.log('[MiMo Non-stream] ChatId extraído da página:', pageChatId);
        currentUrl = `https://chat.mistral.ai/work/${pageChatId}`;
    }
    
    // Se ainda não temos chat válido, extrair do localStorage
    if (!currentUrl.includes('/work/') || currentUrl === 'https://chat.mistral.ai/work') {
        console.log('[MiMo Non-stream] Tentando extrair chats do localStorage...');
        
        let extractedUrl = null;
        try {
            const chatData = await session.page.evaluate(async () => {
                const chats = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && (key.includes('chat') || key.includes('conversation') || key.includes('work-kv-cache'))) {
                        try {
                            chats[key] = JSON.parse(localStorage.getItem(key));
                        } catch { chats[key] = localStorage.getItem(key); }
                    }
                }
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    if (key && (key.includes('chat') || key.includes('conversation') || key.includes('work-kv-cache'))) {
                        try {
                            chats[key] = JSON.parse(sessionStorage.getItem(key));
                        } catch { chats[key] = sessionStorage.getItem(key); }
                    }
                }
                return chats;
            });
            
            console.log('[MiMo Non-stream] Chat data from storage:', JSON.stringify(chatData).slice(0, 2000));
            
            // Extrair UUIDs das chaves do localStorage
            for (const key of Object.keys(chatData)) {
                const uuidMatches = key.match(/\[([^\]]+)\]/);
                if (uuidMatches) {
                    const uuids = uuidMatches[1].split(',').map(u => u.trim().replace(/"/g, ''));
                    console.log('[MiMo Non-stream] UUIDs encontrados:', uuids);
                    if (uuids.length > 0) {
                        extractedUrl = `https://chat.mistral.ai/work/${uuids[0]}`;
                        console.log('[MiMo Non-stream] Usando primeiro UUID:', uuids[0]);
                        break;
                    }
                }
            }
        } catch (e) {
            console.log('[MiMo Non-stream] Erro ao extrair storage:', e.message);
        }
        
        // Navegar para a URL do chat extraída
        if (extractedUrl) {
            currentUrl = extractedUrl;
            console.log('[MiMo Non-stream] Navegando para chat URL:', currentUrl);
            await session.page.goto(currentUrl, { waitUntil: "domcontentloaded" });
            await session.page.waitForTimeout(2000);
            console.log('[MiMo Non-stream] URL após navegação para chat:', session.page.url());
        }
    }
    
    // Determinar chatId final
    let chatId = process.env.MISTRAL_CHAT_ID;
    if (!chatId) {
        const workMatch = currentUrl.match(/\/work\/([^/?#]+)/);
        if (workMatch) {
            chatId = workMatch[1];
            console.log('[MiMo Non-stream] ChatId extraído da URL:', chatId);
        } else {
            chatId = conversationId;
            console.log('[MiMo Non-stream] Usando conversationId como chatId:', chatId);
        }
    }
    
    const result = await session.page.evaluate(async ({ body, fullQuery, chatId, messageId }) => {
        try {
            console.log('[Browser Non-stream] Iniciando fetch para /api/chat');
            console.log('[Browser Non-stream] URL atual:', window.location.href);
            
            const res = await fetch('https://chat.mistral.ai/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    chatId: chatId,
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
            
            if (!res.ok) {
                const errText = await res.text();
                console.error('[Browser Non-stream] Error response body:', errText);
                throw new Error('HTTP ' + res.status + ' ' + errText.slice(0, 500));
            }
            
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
    }, { body: requestData, fullQuery, chatId, messageId });
    
    // Validação de erro
    if (result.status < 200 || result.status >= 300) {
        throw new Error('MiMo retornou erro: ' + result.text);
    }
    
    // Extrai tool calls do texto completo
    const toolCalls = extractToolCalls(result.text);
    const cleanText = removeToolCallsFromText(result.text);
    
    console.log('[MiMo Debug] Raw text length:', result.text.length);
    console.log('[MiMo Debug] Tool calls found:', toolCalls.length);
    console.log('[MiMo Debug] Raw snippet:', result.text.substring(0, 500));
    
    // Detecta "fake tool calls"
    const fakeDetection = detectFakeToolCalls(result.text, requestData.tools);
    if (fakeDetection.fake) {
        console.warn('[MiMo] ⚠️', fakeDetection.hint);
    }
    
    // Se há tool calls, retorna no formato OpenAI
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
    
    // Se o modelo mencionou tools mas não chamou
    if (fakeDetection.fake && requestData.tools && requestData.tools.length > 0) {
        const hint = `\n\n⚠️ [Proxy] O modelo MiMo mencionou as tools (${fakeDetection.mentionedTools.join(', ')}) em texto natural, mas não emitiu chamadas estruturadas. Isso é uma limitação da API web do MiMo (aistudio.xiaomimimo.com) que não suporta tool calling nativo. Considere usar um modelo local (llama.cpp) ou API oficial (platform.xiaomimimo.com) para tarefas que requerem ferramentas.`;
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
    
    // Senão, retorna como texto normal
    return { 
        choices: [{ 
            message: { 
                role: 'assistant', 
                content: cleanText 
            },
            finish_reason: 'stop'
        }] 
    };
}
}