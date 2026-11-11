// src/lechat-parser.js
export class LeChatStreamParser {
    constructor() {
        this.chunks = new Map();
        this.sentContent = 0;
        this.sentReasoning = 0;
        this.finished = false;
    }

    feed(raw) {
        const events = [];
        for (let line of raw.split('\n')) {
            line = line.trim();
            if (!line) continue;
            const m = /^(\d+):(.*)$/.exec(line);   // prefixo tRPC "15:"
            if (!m || m[2] === 'null') continue;
            let msg;
            try { msg = JSON.parse(m[2]); } catch { continue; }
            const patches = msg?.json?.patches;
            if (!Array.isArray(patches)) continue;

            for (const p of patches) {
                const path = p.path || '';
                if (p.op === 'replace' && path === '/generationStatus') {
                    if (p.value === 'success' || p.value === 'failed') this.finished = true;
                    continue;
                }
                const mc = /^\/contentChunks\/(\d+)(\/text|\/_context)?$/.exec(path);
                if (!mc) continue;
                const idx = +mc[1], sub = mc[2];

                if (p.op === 'add' && !sub && p.value && typeof p.value.text === 'string') {
                    this.chunks.set(idx, {
                        text: p.value.text,
                        reasoning: p.value._context?.type === 'reasoning'
                    });
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

            const idxs = [...this.chunks.keys()].sort((a, b) => a - b);
            let content = '', reasoning = '';
            for (const i of idxs) {
                const c = this.chunks.get(i);
                if (c.reasoning) reasoning += c.text; else content += c.text;
            }
            if (content.length > this.sentContent) {
                events.push({ type: 'content', delta: content.slice(this.sentContent) });
                this.sentContent = content.length;
            }
            if (reasoning.length > this.sentReasoning) {
                events.push({ type: 'reasoning', delta: reasoning.slice(this.sentReasoning) });
                this.sentReasoning = reasoning.length;
            }
            if (this.finished) { events.push({ type: 'finish' }); this.finished = false; }
        }
        return events;
    }
}