// src/lechat-parser.js
// Parser do stream tRPC + JSON Patch do Le Chat (chat.mistral.ai)

export class LeChatStreamParser {
    constructor() {
        this.chunks = new Map();   // idx -> { text, reasoning }
        this.sentContent = 0;      // já enviado de content
        this.sentReasoning = 0;    // já enviado de reasoning
        this.finished = false;
        this.callbacks = [];       // task_callbacks do Le Chat (log)
    }

    /** Alimenta o parser com texto bruto do stream; retorna deltas OpenAI */
    feed(raw) {
        const events = [];
        const lines = raw.split('\n');
        
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            
            // Remove prefixo tRPC "15:" / "8:"
            const m = /^(\d+):(.*)$/.exec(line);
            if (!m) continue;
            
            const payload = m[2];
            if (payload === 'null') continue;
            
            let msg;
            try { msg = JSON.parse(payload); } catch { continue; }
            
            const patches = msg?.json?.patches;
            if (!Array.isArray(patches)) continue;
            
            this._applyPatches(patches);
            
            // Emite deltas
            const { content, reasoning } = this._assemble();
            
            if (content.length > this.sentContent) {
                events.push({
                    type: 'content',
                    delta: content.slice(this.sentContent)
                });
                this.sentContent = content.length;
            }
            if (reasoning.length > this.sentReasoning) {
                events.push({
                    type: 'reasoning',
                    delta: reasoning.slice(this.sentReasoning)
                });
                this.sentReasoning = reasoning.length;
            }
            if (this.finished) events.push({ type: 'finish' });
            if (evt.type === 'content') {
    // Acumula texto para detectar tool calls
    this.accumulatedText += evt.delta;
    
    // Verifica se há tool calls completos
    const newToolCalls = extractToolCallsFromText(this.accumulatedText);
    if (newToolCalls.length > this.lastToolCallCount) {
        // Envia apenas os novos tool calls
        const newCalls = newToolCalls.slice(this.lastToolCallCount);
        for (const call of newCalls) {
            events.push({
                type: 'tool_call',
                data: call
            });
        }
        this.lastToolCallCount = newToolCalls.length;
    }
}

if (evt.type === 'finish') {
    // Remove tool calls do texto final antes de enviar
    const cleanText = removeToolCallsFromText(this.accumulatedText);
    events.push({ 
        type: 'final_content', 
        text: cleanText,
        tool_calls: extractToolCallsFromText(this.accumulatedText)
    });
}
        }
        return events;
    }

    _applyPatches(patches) {
        for (const p of patches) {
            const path = p.path || '';
            const mChunk = /^\/contentChunks\/(\d+)(\/text|\/_context)?$/.exec(path);
            
            if (p.op === 'replace' && path === '/generationStatus') {
                if (p.value === 'success' || p.value === 'failed') {
                    this.finished = true;
                }
                continue;
            }
            
            if (!mChunk) continue;
            const idx = +mChunk[1];
            const sub = mChunk[2];
            
            if (p.op === 'add' && !sub && p.value && typeof p.value.text === 'string') {
                this.chunks.set(idx, {
                    text: p.value.text,
                    reasoning: p.value._context?.type === 'reasoning'
                });
            } else if (p.op === 'add' && !sub && p.value?.type === 'task_callback') {
                this.callbacks.push(p.value.callbackName);
                console.log('[LeChat] Tool interna do Le Chat:', p.value.callbackName);
            } else if ((p.op === 'replace' || p.op === 'append') && sub === '/text') {
                const cur = this.chunks.get(idx) || { text: '', reasoning: false };
                cur.text = p.op === 'append' ? cur.text + p.value : p.value;
                this.chunks.set(idx, cur);
            } else if (p.op === 'remove' && !sub) {
                this.chunks.delete(idx);
            } else if (p.op === 'remove' && sub === '/_context') {
                const cur = this.chunks.get(idx);
                if (cur) { cur.reasoning = false; this.chunks.set(idx, cur); }
            }
        }
    }

    /** Reconstrói texto completo em ordem de índice (sobrevive à consolidação) */
    _assemble() {
        const idxs = [...this.chunks.keys()].sort((a, b) => a - b);
        let content = '', reasoning = '';
        for (const i of idxs) {
            const c = this.chunks.get(i);
            if (c.reasoning) reasoning += c.text;
            else content += c.text;
        }
        return { content, reasoning };
    }
}