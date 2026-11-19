'use strict';
/**
 * 扫全库：对每个视频做 3 次跨段 seek（30% / 60% / 90%），看有没有出现秒级。
 * 260 秒上限，边测边打印（万一超时也有部分结果）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

if (process.env.PROBE_CHILD !== '1') {
    const child = spawn(require('electron'), [__filename], { env: { ...process.env, PROBE_CHILD: '1' }, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    return;
}

const watchdog = setTimeout(() => { console.error('260 秒上限'); app.exit(124); }, 260000);
const ROOT = path.resolve(__dirname, '..');
const { registerLocalFileScheme, registerLocalFileProtocol } = require(path.join(ROOT, 'app/main/localprotocol.js'));
registerLocalFileScheme();

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)$/i;
const collect = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { collect(full, out); continue; }
        if (VIDEO_EXT.test(e.name)) out.push(full);
    }
};

/** 只读一遍文件头，拿分辨率与时长（不解码全片） */
const probeInfo = (file) => new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { timeout: 15000, maxBuffer: 1024 * 1024 }, (_e, _o, stderr) => {
        const s = String(stderr);
        const v = /Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(s);
        const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
        const fps = /([\d.]+) fps/.exec(s);
        resolve({
            res: v ? `${v[1]}x${v[2]}` : '?',
            dur: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
            fps: fps ? Number(fps[1]) : 0,
            mb: +(fs.statSync(file).size / 1048576).toFixed(1),
        });
    });
});

app.whenReady().then(async () => {
    registerLocalFileProtocol();
    const files = [];
    collect(path.join(ROOT, 'resource'), files);
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    console.log(`共 ${files.length} 个视频，按体积从大到小\n`);

    const win = new BrowserWindow({ show: true, width: 560, height: 340, webPreferences: { backgroundThrottling: false } });
    await win.loadURL('data:text/html,<body style="margin:0;background:%23000"></body>');

    let worst = { ms: 0, name: '' };
    for (const file of files) {
        const info = await probeInfo(file);
        const url = `tpf://local/${encodeURIComponent(file.replace(/\\/g, '/'))}`;
        const r = await win.webContents.executeJavaScript(`(async () => {
            const v = document.createElement('video');
            v.muted = true;
            v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
            document.body.appendChild(v);
            const ev = [];
            for (const n of ['seeking', 'seeked', 'playing']) v.addEventListener(n, () => ev.push({ n, t: performance.now() }));
            v.src = ${JSON.stringify(url)};
            v.load();
            try { await v.play(); } catch (e) { v.remove(); return { error: e.name }; }
            await new Promise((res) => { v.addEventListener('playing', res, { once: true }); setTimeout(res, 6000); });
            const dur = v.duration;
            if (!Number.isFinite(dur) || dur <= 0) { v.remove(); return { error: 'no duration' }; }
            const out = [];
            for (const frac of [0.3, 0.6, 0.9]) {
                const mark = ev.length;
                const t0 = performance.now();
                v.currentTime = dur * frac;
                let at = null;
                const deadline = t0 + 8000;
                while (performance.now() < deadline) {
                    const pl = ev.slice(mark).find((x) => x.n === 'playing' && x.t > t0);
                    if (pl) { at = Math.round(pl.t - t0); break; }
                    await new Promise((res) => setTimeout(res, 15));
                }
                out.push(at);
                await new Promise((res) => setTimeout(res, 250));
            }
            v.pause(); v.removeAttribute('src'); v.load(); v.remove();
            return { dur: Math.round(dur), marks: out };
        })()`, true);

        const name = path.basename(file).slice(0, 46);
        if (r.error) { console.log(`${name}\n   ${r.error}（跳过）`); continue; }
        const vals = r.marks.filter((x) => x !== null);
        const max = vals.length ? Math.max(...vals) : -1;
        if (max > worst.ms) worst = { ms: max, name };
        console.log(`${name}`);
        console.log(`   ${info.mb}MB ${info.res} ${info.fps ? info.fps + 'fps ' : ''}${r.dur}s | seek: ${r.marks.map((m) => (m === null ? '超时' : m + 'ms')).join(' / ')}  最大 ${max}ms`);
    }

    console.log(`\n最慢的一次：${worst.ms}ms  ${worst.name}`);
    win.destroy();
    clearTimeout(watchdog);
    app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
