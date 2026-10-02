(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.UltimateCanvasPlanSplit = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
    'use strict';
    const VERSION = 1;
    const MAX_PROMPT = 20000;
    const MAX_BYTES = 2 * 1024 * 1024;
    const uuid = () => 'plan-' + crypto.randomUUID();
    const clone = value => JSON.parse(JSON.stringify(value));
    function lines(text) {
        let start = 0;
        return text.split(/(?<=\n)/).map(raw => {
            const row = { start, end: start + raw.length, raw, text: raw.replace(/[\r\n]+$/, '') };
            start = row.end;
            return row;
        });
    }
    function title(line) {
        const value = line.trim().replace(/^#{1,6}\s*/, '');
        if (value.length > 120 || /[。！？“”「」]/.test(value)) return null;
        if (/^(参考|参照|引用|使用|沿用|见|编号)|参照|引用|编号为|参考方案/.test(value)) return null;
        const match = value.match(/^(?:[^()（）]{0,80})[（(]([\p{Script=Han}]{2}\d{3})[）)](?:[^()（）]{0,60})$/u);
        return match ? { title: value, number: match[1] } : null;
    }
    const endLine = line => /^\s*[（(]end[）)]\s*$/i.test(line);
    function body(source, part) {
        return part.ranges.map(range => source.text.slice(range.start, range.end)).join('');
    }
    function sections(text) {
        const rows = lines(text);
        const first = rows.findIndex(row => /^\s*(?:\[|【)?\s*\d+(?:\.\d+)?\s*(?:-|–|—|~|～|至)\s*\d+(?:\.\d+)?\s*(?:秒|s)?/i.test(row.text) || /^\s*sc\d+/i.test(row.text));
        const headingIndex = rows.findIndex(row => row.text.trim());
        const headingEnd = headingIndex >= 0 ? rows[headingIndex].end : 0;
        const head = text.slice(0, headingEnd);
        const split = first < 0 ? text.length : rows[first].start;
        return { title: head, overall: text.slice(headingEnd, split), timeline: text.slice(split) };
    }
    function inspect(text, settings = {}, confirmed = {}) {
        const errors = [], warnings = [];
        const rows = lines(text).filter(row => row.text.trim());
        if (!title(rows[0]?.text || '')) errors.push('标题缺少独立创意编号；正文保留，可先保存草稿。');
        if (!endLine(rows.at(-1)?.text || '')) errors.push('未找到独立 (end)，可保存草稿，补齐后再生成。');
        if (!sections(text).overall.replace(/[（(]end[）)]/gi, '').trim()) errors.push('本方案缺少首段整体要求，请补齐后再生成。');
        if (text.length > MAX_PROMPT) errors.push('本方案超过2万字；正文不会截断，请调整分段。');
        const times = rows.map(row => {
            const match = row.text.match(/^\s*(?:\[|【)?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|~|～|至)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?/i);
            return match ? { start: Number(match[1]), end: Number(match[2]), line: row.text } : null;
        }).filter(Boolean);
        const legacy = rows.some(row => /^\s*sc\d+/i.test(row.text));
        if (legacy || !times.length) {
            warnings.push(legacy ? 'sc镜头写法未换算时间，需确认时间轴。' : '未识别起止时间，需确认时间轴。');
            if (!confirmed.timeline) errors.push('时间轴尚未确认。');
        }
        let previous = 0;
        times.forEach(time => {
            if (Math.abs(time.start - previous) > .01 || time.end <= time.start) errors.push('时间轴不连续：' + time.line);
            previous = time.end;
        });
        if (times.length && Number.isFinite(Number(settings.duration)) && Number(settings.duration) > 0
            && Math.abs(previous - Number(settings.duration)) > .01) errors.push('时间轴结束于' + previous + '秒，与设置的' + settings.duration + '秒不一致。');
        return { errors, warnings, sections: sections(text), complete: errors.length === 0 };
    }
    function unassigned(source, parts, old = []) {
        const ranges = parts.flatMap(part => part.ranges).sort((a, b) => a.start - b.start);
        let cursor = 0;
        const gaps = [];
        for (const range of ranges) {
            if (range.start > cursor) gaps.push({ start: cursor, end: range.start });
            cursor = Math.max(cursor, range.end);
        }
        if (cursor < source.text.length) gaps.push({ start: cursor, end: source.text.length });
        return gaps.filter(range => source.text.slice(range.start, range.end).trim()).map(range => ({
            ...range, id: old.find(item => item.start === range.start && item.end === range.end)?.id || uuid(),
            excluded: old.some(item => item.start === range.start && item.end === range.end && item.excluded)
        }));
    }
    function parse(source) {
        const rows = lines(source.text), parts = [];
        for (let index = 0; index < rows.length; index++) {
            const heading = title(rows[index].text);
            if (!heading) continue;
            let next = index + 1, foundEnd = false;
            while (next < rows.length) {
                if (endLine(rows[next].text)) { next++; foundEnd = true; break; }
                if (title(rows[next].text)) break;
                next++;
            }
            const end = next === rows.length ? source.text.length : rows[next].start;
            const part = { id: uuid(), title: heading.title, number: heading.number,
                ranges: [{ start: rows[index].start, end }], selected: false,
                boundaryConfirmed: foundEnd, timelineConfirmed: false };
            part.selected = inspect(body(source, part), {}, { boundary: part.boundaryConfirmed }).complete;
            parts.push(part);
            index = next - 1;
        }
        return { version: VERSION, operationId: uuid(), parts, unassigned: unassigned(source, parts) };
    }
    function rangesValid(source, parts) {
        const ranges = parts.flatMap(part => part.ranges).sort((a, b) => a.start - b.start);
        let end = 0;
        return ranges.every(range => {
            const valid = Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= end
                && range.end > range.start && range.end <= source.text.length;
            end = range.end;
            return valid;
        });
    }
    function contentSignature(node) {
        return JSON.stringify({ title: node.data?.title || '', prompt: node.data?.prompt || '', settings: node.data?.videoSettings || {},
            refs: node.data?.planReferences || [], mode: node.data?.mode || '', x: node.x, y: node.y,
            contextRules: node.data?.contextRules || {}, cameraPresets: node.data?.cameraPresets || [],
            boundary: node.data?.planSource?.boundaryConfirmed, timeline: node.data?.planSource?.timelineConfirmed });
    }
    async function revision(text) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    function empty() { return { version: VERSION, sources: {}, drafts: {}, operations: {} }; }
    function byteSize(snapshot) { return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength; }
    return { VERSION, MAX_PROMPT, MAX_BYTES, uuid, clone, lines, title, endLine, body, sections, inspect,
        unassigned, parse, rangesValid, contentSignature, revision, empty, byteSize };
});
