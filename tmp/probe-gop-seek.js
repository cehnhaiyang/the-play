'use strict';
/**
 * 闭环测量：同一个文件（16MB / 关键帧间隔 10.4s），做两组**受控** seek：
 *   A) 落在关键帧之后 0.2s —— 解码器几乎不用前进
 *   B) 落在下一个关键帧之前 ~1s —— 要解码近 10 秒的帧
 * 如果 B 明显慢于 A，就证明秒级卡顿来自 GOP 解码，而不是取流。
 * 70 秒硬超时。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

if (process.env.PROBE_CHILD !== '1') {
    const child = spawn(require('electron'), [__filename], { env: { ...process.env, PROBE_CHILD: '1' }, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    return;
}

const watchdog = setTimeout(() => { console.error('70 秒上限'); app.exit(124); }, 70000);
const ROOT = path.resolve(__dirname, '..');
const { registerLocalFileScheme, registerLocalFileProtocol } = require(path.join(ROOT, 'app/main/localprotocol.js'));
registerLocalFileScheme();

const FILE = path.join(ROOT, 'resource/video/the last of us ellie has audio animated hentai anime by sfmlottie.mp4');

/** ffmpeg 打印关键帧时间戳 */
const keyframes = () => new Promise((resolve) => {
    execFile(ffmpeg, ['-v', 'info', '-skip_frame', 'nokey', '-i', FILE, '-an', '-vf', 'showinfo', '-vsync', '0', '-f', 'null', '-'],
        { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (_e, _o, stderr) => {
            const times = [];
            for (const m of String(stderr).matchAll(/pts_time:([0-9.]+)/g)) times.push(Number(m[1]));
            resolve(times);
        });
});

app.whenReady().then(async () => {
    registerLocalFileProtocol();
    const kf = await keyframes();
    console.log(`文件 ${path.basename(FILE)} ${(fs.statSync(FILE).size / 1048576).toFixed(1)}MB  关键帧 ${kf.length} 个`);
    console.log(`  关键帧时刻: ${kf.map((t) => t.toFixed(1)).join(', ')}`);

    // 组装两组落点：紧贴关键帧 / 逼近下一个关键帧
    const near = [];
    const far = [];
    for (let i = 1; i < kf.length - 1 && near.length < 4; i += 1) {
        const start = kf[i];
        const next = kf[i + 1];
        if (next - start < 1) continue;
        near.push({ t: +(start + 0.2).toFixed(2), fromKf: 0.2 });
        far.push({ t: +(next - 1).toFixed(2), fromKf: +(next - 1 - start).toFixed(2) });
    }
    console.log(`  A 组落点（关键帧+0.2s）: ${near.map((x) => x.t + 's').join(', ')}`);
    console.log(`  B 组落点（下一关键帧前 1s）: ${far.map((x) => `${x.t}s(距 ${x.fromKf}s)`).join(', ')}`);

    const win = new BrowserWindow({ show: true, width: 640, height: 400, webPreferences: { backgroundThrottling: false } });
    await win.loadURL('data:text/html,<body style="margin:0;background:%23000"></body>');

    const url = `tpf://local/${encodeURIComponent(FILE.replace(/\\/g, '/'))}`;
    const result = await win.webContents.executeJavaScript(`(async () => {
        const v = document.createElement('video');
        v.muted = true;
        v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
        document.body.appendChild(v);
        const ev = [];
        for (const n of ['seeking', 'seeked', 'playing', 'waiting', 'canplay'])
            v.addEventListener(n, () => ev.push({ n, t: performance.now() }));
        v.src = ${JSON.stringify(url)};
        v.load();
        try { await v.play(); } catch (e) { return { error: e.name + ' ' + e.message }; }
        await new Promise((r) => { v.addEventListener('playing', r, { once: true }); setTimeout(r, 5000); });

        const seek = async (target) => {
            const mark = ev.length;
            const t0 = performance.now();
            v.currentTime = target;
            let seekedAt = null;
            let playingAt = null;
            const deadline = t0 + 8000;
            while (performance.now() < deadline) {
                const slice = ev.slice(mark);
                const sk = slice.find((x) => x.n === 'seeked');
                const pl = slice.find((x) => x.n === 'playing' && x.t > t0);
                if (sk && seekedAt === null) seekedAt = Math.round(sk.t - t0);
                if (pl) { playingAt = Math.round(pl.t - t0); break; }
                await new Promise((r) => setTimeout(r, 20));
            }
            await new Promise((r) => setTimeout(r, 350));
            return { seekedAt, playingAt };
        };

        const groups = { A: [], B: [] };
        const plan = [
            ['A', ${JSON.stringify(near)}],
            ['B', ${JSON.stringify(far)}],
            ['A', ${JSON.stringify(near)}],
            ['B', ${JSON.stringify(far)}],
        ];
        for (const [name, list] of plan) {
            for (const item of list) {
                const r = await seek(item.t);
                groups[name].push({ t: item.t, fromKf: item.fromKf, ...r });
            }
        }
        v.pause(); v.removeAttribute('src'); v.load(); v.remove();
        return groups;
    })()`, true);

    if (result.error) { console.log('失败:', result.error); app.exit(1); return; }

    for (const name of ['A', 'B']) {
        const rows = result[name];
        const label = name === 'A' ? 'A 紧贴关键帧' : 'B 逼近下一关键帧';
        const seekeds = rows.map((r) => r.seekedAt).filter((x) => x !== null);
        const plays = rows.map((r) => r.playingAt).filter((x) => x !== null);
        console.log(`\n${label}（${rows.length} 次）`);
        console.log('  ' + rows.map((r) => `${r.t}s(距关键帧${r.fromKf}s)→ seeked ${r.seekedAt}ms / playing ${r.playingAt === null ? '未触发' : r.playingAt + 'ms'}`).join('\n  '));
        if (seekeds.length) console.log(`  最大 seeked ${Math.max(...seekeds)}ms，平均 ${Math.round(seekeds.reduce((a, b) => a + b, 0) / seekeds.length)}ms`);
        if (plays.length) console.log(`  最大 playing ${Math.max(...plays)}ms，平均 ${Math.round(plays.reduce((a, b) => a + b, 0) / plays.length)}ms`);
    }

    win.destroy();
    clearTimeout(watchdog);
    app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
