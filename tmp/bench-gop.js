'use strict';
/**
 * 量「钉密关键帧」的真实代价：
 *   1. 源文件的分辨率/码率
 *   2. 剪 10 秒用 libx264 CRF18 + 2s 关键帧重编码，看速度与体积
 * 60 秒硬超时。
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('ffmpeg-static');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'resource/video/与怪异做爱的超工口女高.mp4');
const OUT = path.join(__dirname, 'gop-test.mp4');
const watchdog = setTimeout(() => { console.error('60 秒上限'); process.exit(124); }, 60000);

const run = (args, timeout = 50000) => new Promise((resolve) => {
    execFile(ffmpeg, args, { maxBuffer: 8 * 1024 * 1024, timeout }, (_err, stdout, stderr) => resolve(String(stderr)));
});

(async () => {
    const info = await run(['-hide_banner', '-i', SRC]);
    const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
    const video = /Stream #0:0[^\n]*Video: ([^\n]+)/.exec(info);
    const bitrate = /bitrate: (\d+) kb\/s/.exec(info);
    console.log('源:', path.basename(SRC), `${(fs.statSync(SRC).size / 1048576).toFixed(1)}MB`);
    if (dur) console.log('  时长:', `${dur[1]}:${dur[2]}:${dur[3]}`);
    if (video) console.log('  视频:', video[1].slice(0, 110));
    if (bitrate) console.log('  总码率:', bitrate[1], 'kb/s');

    if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
    const t0 = Date.now();
    // 只重编码视频流，音频直接 copy —— 与"钉密关键帧"的实际做法一致
    const log = await run([
        '-y', '-hide_banner', '-ss', '0', '-t', '10', '-i', SRC,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
        '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
        '-c:a', 'copy', OUT,
    ]);
    const wall = (Date.now() - t0) / 1000;
    const speed = /speed=([\d.]+)x/.exec(log);
    const fps = /fps=\s*([\d.]+)/.exec(log);
    const outSize = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
    console.log('\n重编码 10 秒（libx264 CRF18 veryfast，每 2 秒一个关键帧，音频 copy）:');
    console.log(`  实际耗时 ${wall.toFixed(1)}s  ${speed ? `编码速度 ${speed[1]}x` : ''} ${fps ? `(${fps[1]} fps)` : ''}`);
    console.log(`  输出体积 ${(outSize / 1048576).toFixed(2)}MB（源 10 秒约 ${(fs.statSync(SRC).size / 1048576 / (Number(dur ? dur[1] * 60 + Number(dur[2]) : 1) * 60) * 10).toFixed(2)}MB）`);
    if (speed) {
        const total = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
        if (total > 0) console.log(`  按 ${speed[1]}x 推算：这部 ${(total / 60).toFixed(0)} 分钟的片子约需 ${(total / Number(speed[1]) / 60).toFixed(1)} 分钟`);
    }
    if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
    clearTimeout(watchdog);
})();
