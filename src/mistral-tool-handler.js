// src/mistral-tool-handler.js

/**
 * Injeta definições de tools no system prompt ou mensagem do usuário
 * Formato otimizado para modelos Mistral
 */
export function injectToolsIntoPrompt(messages, tools, toolChoice = 'auto') {
    if (!tools || tools.length === 0) return messages;
    
    // Cria um system prompt simplificado com as tools
    let toolsPrompt = '\n\n# AVAILABLE TOOLS\n';
    toolsPrompt += 'You have access to the following tools. When you need to use a tool, you MUST output it in this exact XML format:\n\n';
    toolsPrompt += '<tool_call>\n<name>TOOL_NAME</name>\n<arguments>{"param":"value"}</arguments>\n</tool_call>\n\n';
    
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const f = tool.function;
            toolsPrompt += `## Tool: ${f.name}\n`;
            if (f.description) toolsPrompt += `${f.description}\n`;
            if (f.parameters) {
                toolsPrompt += `Parameters: ${JSON.stringify(f.parameters)}\n`;
            }
            toolsPrompt += '\n';
        }
    }
    
    if (toolChoice === 'required') {
        toolsPrompt += '\n**IMPORTANT: You MUST use at least one tool in this response.**\n';
    }
    
    // Adiciona o prompt de tools à última mensagem do usuário
    const newMessages = [...messages];
    for (let i = newMessages.length - 1; i >= 0; i--) {
        if (newMessages[i].role === 'user') {
            newMessages[i] = {
                ...newMessages[i],
                content: (typeof newMessages[i].content === 'string' 
                    ? newMessages[i].content 
                    : newMessages[i].content?.text || '') + toolsPrompt
            };
            break;
        }
    }
    
    return newMessages;
}

/**
 * Extrai tool calls de múltiplos formatos que o Mistral pode gerar
 */
export function extractToolCallsFromText(text) {
    const toolCalls = [];
    const seen = new Set();
    let index = 0;
    
    // Padrão 1: XML <tool_call>
    const re1 = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
    let m;
    while ((m = re1.exec(text)) !== null) {
        try {
            const name = m[1].trim();
            const argsStr = m[2].trim();
            const key = `${name}:${argsStr}`;
            if (!seen.has(key)) {
                seen.add(key);
                toolCalls.push({
                    id: `call_${Date.now()}_${index++}`,
                    type: 'function',
                    function: { name, arguments: argsStr }
                });
            }
        } catch {}
    }
    
    // Padrão 2: TOOL_CALL: name {json}
    const re2 = /TOOL_CALL:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[\s\S]*?\})(?=\n|$)/g;
    while ((m = re2.exec(text)) !== null) {
        try {
            const name = m[1].trim();
            const argsStr = m[2].trim();
            const key = `${name}:${argsStr}`;
            if (!seen.has(key)) {
                seen.add(key);
                toolCalls.push({
                    id: `call_${Date.now()}_${index++}`,
                    type: 'function',
                    function: { name, arguments: argsStr }
                });
            }
        } catch {}
    }
    
    return toolCalls;
}

/**
 * Remove tool calls do texto final para mostrar ao usuário
 */
export function removeToolCallsFromText(text) {
    return text
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/TOOL_CALL:\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\{[\s\S]*?\}(?=\n|$)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Detecta se o modelo mencionou tools mas não chamou (alucinação)
 */
export function detectFakeToolCalls(text, availableTools) {
    if (!availableTools || availableTools.length === 0) return { fake: false };
    
    const toolNames = availableTools
        .filter(t => t.type === 'function' && t.function)
        .map(t => t.function.name);
    
    const mentionedTools = toolNames.filter(name => {
        const regex = new RegExp(`\\b${name}\\b`, 'i');
        return regex.test(text);
    });
    
    const hasRealCalls = extractToolCallsFromText(text).length > 0;
    
    if (mentionedTools.length > 0 && !hasRealCalls) {
        return {
            fake: true,
            mentionedTools,
            hint: `O Mistral mencionou tools (${mentionedTools.join(', ')}) mas não emitiu chamadas reais.`
        };
    }
    
    return { fake: false };
}