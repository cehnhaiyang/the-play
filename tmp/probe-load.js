'use strict';
/**
 * 带负载测 seek：同一文件、同一批落点，三种条件对比
 *   A 空载          基线
 *   B 主进程被占    每 300ms 让主进程忙 200ms（模拟抓图/IPC/扫盘占住 JS 线程）
 *   C 磁盘写满      子进程持续写 400MB（模拟同时下载落盘）
 * 如果 B 的 seek 明显变慢，就证明 tpf: 的分段取流被主进程拖住。
 * 110 秒硬超时。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

if (process.env.PROBE_CHILD !== '1') {
    const child = spawn(require('electron'), [__filename], { env: { ...process.env, PROBE_CHILD: '1' }, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    return;
}

const watchdog = setTimeout(() => { console.error('110 秒上限'); app.exit(124); }, 110000);
const ROOT = path.resolve(__dirname, '..');
const { registerLocalFileScheme, registerLocalFileProtocol } = require(path.join(ROOT, 'app/main/localprotocol.js'));
registerLocalFileScheme();

const FILE = path.join(ROOT, 'resource/video/与怪异做爱的超工口女高.mp4');
const TMP_BIN = path.join(__dirname, 'disk-load.bin');

/** 让主进程 JS 线程忙 ms 毫秒（同步空转，真实地占住事件循环） */
let blocker = null;
const startBlocking = (everyMs, busyMs) => {
    blocker = setInterval(() => {
        const end = Date.now() + busyMs;
        while (Date.now() < end) { /* 故意空转 */ }
    }, everyMs);
};
const stopBlocking = () => { if (blocker) { clearInterval(blocker); blocker = null; } };

app.whenReady().then(async () => {
    registerLocalFileProtocol();
    const win = new BrowserWindow({ show: true, width: 560, height: 340, webPreferences: { backgroundThrottling: false } });
    await win.loadURL('data:text/html,<body style="margin:0;background:%23000"></body>');

    const url = `tpf://local/${encodeURIComponent(FILE.replace(/\\/g, '/'))}`;

    /** 建一个播放器并留在页面里，后续各阶段复用它 */
    await win.webContents.executeJavaScript(`(async () => {
        const v = document.createElement('video');
        v.id = 'probe';
        v.muted = true;
        v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
        document.body.appendChild(v);
        window.__ev = [];
        for (const n of ['seeking', 'seeked', 'playing']) v.addEventListener(n, () => window.__ev.push({ n, t: performance.now() }));
        v.src = ${JSON.stringify(url)};
        v.load();
        await v.play().catch(() => {});
        await new Promise((res) => { v.addEventListener('playing', res, { once: true }); setTimeout(res, 6000); });
        return { dur: Math.round(v.duration) };
    })()`, true);

    const seekBatch = async (label) => win.webContents.executeJavaScript(`(async () => {
        const v = document.getElementById('probe');
        const dur = v.duration;
        const out = [];
        for (const frac of [0.15, 0.45, 0.7, 0.9]) {
            const mark = window.__ev.length;
            const t0 = performance.now();
            v.currentTime = dur * frac;
            let at = null;
            const deadline = t0 + 9000;
            while (performance.now() < deadline) {
                const pl = window.__ev.slice(mark).find((x) => x.n === 'playing' && x.t > t0);
                if (pl) { at = Math.round(pl.t - t0); break; }
                await new Promise((res) => setTimeout(res, 15));
            }
            out.push(at);
            await new Promise((res) => setTimeout(res, 300));
        }
        return out;
    })()`, true).then((marks) => {
        const vals = marks.filter((x) => x !== null);
        const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : -1;
        console.log(`[${label}] ${marks.map((m) => (m === null ? '超时' : m + 'ms')).join(' / ')}`);
        console.log(`   平均 ${avg}ms  最大 ${vals.length ? Math.max(...vals) : '-'}ms`);
        return { avg, max: vals.length ? Math.max(...vals) : -1 };
    });

    console.log(`文件 ${path.basename(FILE)} ${(fs.statSync(FILE).size / 1048576).toFixed(0)}MB\n`);
    const idle = await seekBatch('A 空载');

    console.log('\n--- B：主进程每 300ms 忙 200ms（约 66% 占用）---');
    startBlocking(300, 200);
    const busy = await seekBatch('B 主进程被占');
    stopBlocking();

    console.log('\n--- C：子进程持续写盘 400MB ---');
    const writer = spawn(process.execPath, ['-e', `
        const fs = require('fs');
        const buf = Buffer.alloc(8 * 1024 * 1024, 7);
        const fd = fs.openSync(${JSON.stringify(TMP_BIN)}, 'w');
        for (let i = 0; i < 50; i += 1) fs.writeSync(fd, buf);
        fs.closeSync(fd);
    `], { stdio: 'ignore' });
    const disk = await seekBatch('C 磁盘忙');
    try { writer.kill(); } catch { /* ignore */ }
    try { fs.unlinkSync(TMP_BIN); } catch { /* ignore */ }

    console.log(`\n结论：空载 ${idle.avg}ms → 主进程被占 ${busy.avg}ms（×${idle.avg > 0 ? (busy.avg / idle.avg).toFixed(1) : '?'}） → 磁盘忙 ${disk.avg}ms`);
    win.destroy();
    clearTimeout(watchdog);
    app.exit(0);
}).catch((e) => { console.error(e); stopBlocking(); app.exit(1); });
