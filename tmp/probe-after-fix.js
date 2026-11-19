'use strict';
/**
 * 修复后复测：真实应用界面点「快进 10 秒」，分别量
 *   点击 → seeking（渲染层开销）
 *   seeking → 出画（媒体开销）
 *   点击 → 出画（总耗时）
 * 对照修复前：seeking 72–113ms，总计 320–400ms。
 * 100 秒硬超时；只读，不改产品代码。
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let vite = null;
let app = null;
const kill = (c) => { if (!c) return; try { execFileSync('taskkill', ['/F', '/T', '/PID', String(c.pid)]); } catch { /* ignore */ } };
const watchdog = setTimeout(() => { console.error('100 秒上限'); kill(app); kill(vite); process.exit(124); }, 100000);

const open = (host, port) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(600, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
});
const getJson = (url) => new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
});

(async () => {
    if (!(await open('127.0.0.1', 5173))) {
        vite = spawn('node', [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: ROOT, stdio: 'ignore' });
        for (let i = 0; i < 40; i += 1) { await sleep(500); if (await open('127.0.0.1', 5173)) break; }
    }
    app = spawn(require('electron'), ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(__dirname, 'diag2')}`], { cwd: ROOT, stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
        await sleep(500);
        try {
            const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
            target = list.find((t) => t.type === 'page' && t.url === 'http://localhost:5173/');
        } catch { /* 等 */ }
    }
    if (!target) throw new Error('主页面没起来');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws timeout')), 5000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.t); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); };
    const call = (method, params = {}) => new Promise((res, rej) => { const n = ++id; const t = setTimeout(() => rej(new Error(method + ' timeout')), 30000); pending.set(n, { res, rej, t }); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expr, awaitPromise = false) => {
        const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
    };

    // 等库扫完
    for (let i = 0; i < 30; i += 1) {
        if ((await ev(`document.querySelectorAll('button').length`)) > 10) break;
        await sleep(400);
    }
    console.log('播放列表:', await ev(`document.body.innerText.slice(0, 40).replace(/\\n/g, '|')`));

    const picked = await ev(`(async () => {
        const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('视频'));
        if (tab) tab.click();
        await new Promise((r) => setTimeout(r, 600));
        const label = [...document.querySelectorAll('p')].find((p) => /\\.(mp4|mkv|webm|mov)/i.test(p.textContent || '') && (p.getAttribute('title') || '').includes('与怪异'))
            || [...document.querySelectorAll('p')].find((p) => /\\.(mp4|mkv|webm|mov)/i.test(p.textContent || ''));
        if (!label) return { error: '没有视频行' };
        const row = label.closest('div[class*="cursor-pointer"]') || label.parentElement.parentElement;
        row.click();
        return { clicked: (label.textContent || '').slice(0, 40) };
    })()`, true);
    console.log('选中:', JSON.stringify(picked));
    await sleep(1500);

    const ready = await ev(`(() => { const v = document.querySelector('video'); return v ? { paused: v.paused, ready: v.readyState, dur: Math.round(v.duration) } : null; })()`);
    console.log('播放器:', JSON.stringify(ready));
    if (!ready) throw new Error('没有 video 元素');
    console.log('DevTools 窗口数（应为 0）:', await ev(`document.querySelectorAll('video').length`));

    await ev(`(() => {
        const v = document.querySelector('video');
        window.__ev = [];
        for (const n of ['seeking', 'seeked', 'playing', 'waiting'])
            v.addEventListener(n, () => window.__ev.push({ n, t: performance.now() }));
        window.__spin = () => document.body.innerText.includes('正在缓冲');
        return true;
    })()`);

    const out = await ev(`(async () => {
        const v = document.querySelector('video');
        const btns = [...document.querySelectorAll('.tp-seek-btn')];
        const fwd = btns[btns.length - 1];
        if (!fwd) return { error: '没有快进按钮' };
        const rows = [];
        for (let i = 0; i < 6; i += 1) {
            const mark = window.__ev.length;
            const t0 = performance.now();
            fwd.click();
            let seekingAt = null, seekedAt = null, playingAt = null;
            let spin = false;
            const deadline = t0 + 9000;
            while (performance.now() < deadline) {
                const slice = window.__ev.slice(mark);
                const sk = slice.find((x) => x.n === 'seeking');
                const sd = slice.find((x) => x.n === 'seeked');
                const pl = slice.find((x) => x.n === 'playing');
                if (sk && seekingAt === null) seekingAt = Math.round(sk.t - t0);
                if (sd && seekedAt === null) seekedAt = Math.round(sd.t - t0);
                if (pl) { playingAt = Math.round(pl.t - t0); break; }
                if (window.__spin()) spin = true;
                await new Promise((r) => setTimeout(r, 10));
            }
            rows.push({ seekingAt, seekedAt, playingAt, spin });
            await new Promise((r) => setTimeout(r, 1200));
        }
        return { rows };
    })()`, true);

    if (out.error) throw new Error(out.error);
    console.log('\n每次快进（点击 → seeking → seeked → 出画）:');
    for (const [i, r] of out.rows.entries()) {
        console.log(`  #${i + 1}  seeking ${r.seekingAt}ms  seeked ${r.seekedAt}ms  出画 ${r.playingAt === null ? '超时' : r.playingAt + 'ms'}${r.spin ? '  [转圈]' : ''}`);
    }
    const pick = (k) => out.rows.map((r) => r[k]).filter((x) => x !== null && x !== undefined);
    const stat = (arr) => (arr.length ? `平均 ${Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)}ms  最大 ${Math.max(...arr)}ms` : '-');
    console.log(`\n点击→seeking（渲染层）: ${stat(pick('seekingAt'))}`);
    console.log(`点击→出画（总计）      : ${stat(pick('playingAt'))}`);
    console.log('修复前对照             : seeking 72–113ms，总计 320–400ms');

    ws.close();
    clearTimeout(watchdog);
    kill(app);
    kill(vite);
    process.exit(0);
})().catch((e) => {
    console.error(e.message || e);
    clearTimeout(watchdog);
    kill(app); kill(vite);
    process.exit(1);
});
