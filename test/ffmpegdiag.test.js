'use strict';
/**
 * ffmpeg 失败诊断的回归测试。
 *
 * 真实故障：保存时报
 *     [out#0/mp4 @ ...] Output file does not contain any stream
 *     Error opening output file D:\...\x.mp4
 * 这是**症状**，不是原因。旧实现取 stderr 末尾 3 行，于是真正的原因
 * （Server returned 403 / Failed to open segment / Invalid data found）
 * 被丢掉，用户只看到"没写出东西"，无法判断下一步做什么。
 *
 * 这里钉：summarizeFfmpegError 必须挑出原因行；挑不出时才退回症状行。
 * 另外钉住"回退直链"的判据：只有 ffmpeg 报"没有流/数据不是媒体"才回退，
 * 其它失败（403、超时）原样抛出，不能把播放列表文本当文件存下来。
 */
const fs = require('fs');
const path = require('path');

const check = (name, fn, state) => {
    try { fn(); state.pass += 1; }
    catch (e) { state.fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

const MAIN = path.join(__dirname, '..', 'app', 'main', 'main.js');

/**
 * main.js 不能直接 require（会拉起 electron），所以把 summarizeFfmpegError
 * 的函数体切出来在沙箱里求值 —— 测的是**真实源码**，不是复刻一份。
 */
const loadSummarizer = () => {
    const src = fs.readFileSync(MAIN, 'utf8');
    const start = src.indexOf('function summarizeFfmpegError(');
    assert(start >= 0, 'main.js 里找不到 summarizeFfmpegError');
    // 从函数头找到配对的结束大括号
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    assert(end > start, 'summarizeFfmpegError 的函数体没闭合');
    const body = src.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return summarizeFfmpegError;`)();
};

const run = () => {
    const state = { pass: 0, fails: [] };
    const summarize = loadSummarizer();

    check('末尾三行只是症状：必须给出更早的原因行', () => {
        const stderr = [
            '[hls @ 0000] Opening \'https://cdn/x.m3u8\' for reading',
            '[https @ 0000] HTTP error 403 Forbidden',
            '[hls @ 0000] Failed to open segment 1 of playlist 0',
            '[out#0/mp4 @ 0000] Output file does not contain any stream',
            'Error opening output file D:\\the-play\\resource\\acgmho\\x.mp4',
            'Error opening output files: Invalid argument',
        ].join('\n');
        const msg = summarize(stderr, 1);
        assert(/403|Failed to open segment/.test(msg), `应指出真实原因，实际：${msg}`);
        assert(!/Output file does not contain any stream/.test(msg),
            `不该只回症状行，实际：${msg}`);
    }, state);

    check('只有症状行时退回最后一行，不抛错、不返回空串', () => {
        const stderr = [
            '[out#0/mp4 @ 0] Output file does not contain any stream',
            'Error opening output files: Invalid argument',
        ].join('\n');
        const msg = summarize(stderr, 1);
        assert(msg.length > 0, '不能返回空串');
        assert(/Invalid argument|does not contain any stream/.test(msg), msg);
    }, state);

    check('空 stderr 回落到退出码', () => {
        eq(summarize('', 7), 'ffmpeg 执行失败，退出码 7');
        eq(summarize('   \n\n', 9), 'ffmpeg 执行失败，退出码 9');
    }, state);

    check('诊断信息不被截断在路径中间（上限 400）', () => {
        const long = `[https @ 0] Server returned 403 Forbidden ${'x'.repeat(500)}`;
        const msg = summarize(long, 1);
        assert(msg.length <= 400, `消息应封顶 400，实际 ${msg.length}`);
        assert(/403 Forbidden/.test(msg), '原因部分必须保留');
    }, state);

    check('回退直链只在"没有流/数据不是媒体"时触发', () => {
        const src = fs.readFileSync(MAIN, 'utf8');
        // 回退判据必须锚在这两种错误上
        assert(/does not contain any stream\|Invalid data found/.test(src),
            '回退判据应只认"没有流/数据不是媒体"');
        // 回退前必须探 Content-Type，避免把 m3u8 文本存成 .mp4
        assert(/probeIsDirectMedia\s*\(/.test(src), '回退前必须探 Content-Type');
        assert(/mpegurl\|dash\\\+xml\|text\\\//.test(src),
            'Content-Type 判据必须排除播放列表与文本');
        // 回退前清掉 ffmpeg 留下的空文件，否则"已存在就跳过"会让回退变空操作
        assert(/fs\.unlinkSync\(targetPath\)/.test(src), '回退前要清掉空文件');
        // 文案不能再说"通过 ffmpeg"
        assert(/fellBackToDirect/.test(src), '回退后文案要区分，不能仍写"通过 ffmpeg"');
    }, state);

    if (state.fails.length > 0) {
        for (const f of state.fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  ffmpeg 诊断 ${state.pass} pass / ${state.fails.length} fail`);
    return state.fails.length === 0;
};

module.exports = { run };
