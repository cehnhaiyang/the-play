'use strict';
/**
 * 本地已下载视频「卡在正在加载」的回归测试。
 *
 * 先排除了文件本身：本机所有已下载的 mp4 都是 ftyp/free/mdat/moov（moov 在末尾），
 * 用可见的 320×180 元素打开，首帧 96~186ms，moov 在前在后只差 ~30ms。
 *
 * 原因在播放器自己这边，三条都能在源码里查：
 *   1. isBuffering 只有 loadedmetadata 与 playing 两个清零点；先来一次 waiting
 *      而没有后续 playing（暂停下 seek、起播被打断）遮罩就永久挂着。
 *   2. play() 的 AbortError 被当成"元素被降优先级"这类玄学处理，还加了一次重试。
 *      实测它只有两个来源：新的装载请求、或 pause()。按"被别人接管"放手即可。
 *   3. 窗口被别的程序完全遮挡时，Chromium 默认把渲染进程判成 hidden：实测遮挡
 *      10.4 秒内视频帧呈现 0 帧、rAF 冻住，而媒体时钟照走。靠 backgroundThrottling
 *      关掉这条降频（见 createWindow）。
 *
 * 也把这处误判钉在测试里：Chrome 实测不会因为元素不可见就挂起媒体 —— 出视口 /
 * display:none / visibility:hidden / opacity:0 / 被不透明层覆盖 / 2×2 / 0×0 /
 * clip-path / content-visibility 全都照常起播。所以代码里不该再出现围绕"不可见"
 * 或 readyState 的特判。注意那说的是 DOM 元素，与第 3 条的**窗口**遮挡是两回事。
 *
 * 另外给新下载的 mp4 补 -movflags +faststart：本地起播差别不大，但边下边播与
 * 远程回放时不必先把整片读到尾巴才拿到索引。
 *
 * 最后一条是「重启后必然无限缓冲」的真正原因，也是本文件最贵的一课：保存到本地
 * 之后播放列表里的地址是 `file://`（pathToFileURL），而渲染层在开发态是
 * `http://localhost:5173` 来源 —— 从非 file 来源加载 file:// 媒体会被 Blink 拒收
 * （"Media load rejected by URL safety check"、networkState 3、currentTime 恒 0），
 * 表现为播放器一直转圈，而文件本身完好。修法是主进程自己用 `tpf:` 协议供流。
 */
const fs = require('fs');
const path = require('path');

const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

const ROOT = path.join(__dirname, '..');
const read = (...seg) => fs.readFileSync(path.join(ROOT, ...seg), 'utf8');

const run = () => {
    const fails = [];
    let pass = 0;
    const check = (name, fn) => {
        try { fn(); pass += 1; }
        catch (e) { fails.push({ name, message: e.message }); }
    };

    const hook = read('app', 'hooks', 'usePlay.ts');
    const main = read('app', 'main', 'main.js');
    // 协议实现单独成模块（便于独立测量），断言打在它身上而不是 main.js
    const protocolSrc = read('app', 'main', 'localprotocol.js');
    const panel = read('app', 'components', 'PlayPanel.tsx');

    const autoplay = (() => {
        const i = hook.indexOf('const attemptAutoplay = useCallback');
        return i < 0 ? '' : hook.slice(i, i + 1800);
    })();

    check('AbortError 按「被别人接管」处理，不重试也不报错', () => {
        assert(autoplay, '找不到 attemptAutoplay');
        assert(/name === 'AbortError'/.test(autoplay), '要单独处理 AbortError');
        assert(/video\.src === srcAtCall/.test(autoplay),
            '要能分辨换源接管（放手）与用户暂停（收掉缓冲遮罩）');
        assert(!/setTimeout\(\(\) => start\(false\)/.test(autoplay),
            '不要重试：AbortError 只来自换源或 pause()，重试会把用户刚按下的暂停重新拉起');
        assert(!/readyState/.test(autoplay),
            '不要拿 readyState/paused 自造「是否卡住」的判据 —— 那是没有依据的猜测');
    });

    check('缓冲态有多个清零点，不再只认 playing', () => {
        assert(/const onReady = /.test(hook), '要有清缓冲的统一处理器');
        assert(/addEventListener\('canplay', onReady\)/.test(hook), 'canplay 要清缓冲');
        assert(/addEventListener\('seeked', onReady\)/.test(hook), 'seeked 要清缓冲');
        assert(/removeEventListener\('canplay', onReady\)/.test(hook)
            && /removeEventListener\('seeked', onReady\)/.test(hook), '解绑要对齐，否则重复绑定');
    });

    check('下载 mp4 时把 moov 放到文件头', () => {
        assert(/'\+faststart'/.test(main), '要传 -movflags +faststart');
        const i = main.indexOf("'-movflags'");
        const around = main.slice(Math.max(0, i - 700), i + 200);
        assert(/\.mp4\$\/i\.test\(filePath\)/.test(around),
            '只对 mp4 输出加：其它容器 / webm 不认这个 flag');
        assert(/'-c',\s*\n\s*'copy',/.test(main), '仍然是 -c copy（不重编码）');
    });

    check('窗口不被后台降频（切到别的程序时画面继续呈现）', () => {
        const i = main.indexOf('webPreferences: {');
        assert(i >= 0, '找不到 createWindow 的 webPreferences');
        const block = main.slice(i, i + 1200);
        assert(/backgroundThrottling:\s*false/.test(block),
            '必须显式关掉：默认 true 时窗口被别的程序遮挡会被判成 hidden，实测遮挡 10.4s 内'
            + '帧呈现 0 帧、rAF 冻住，而媒体时钟照走（声音在、画面不动）');
    });

    /* ====================================================================== */
    /* 本地文件绝不能交给渲染层用 file:// 加载                                 */
    /* ====================================================================== */

    /**
     * 这条是本文件最贵的一课：`file://` 在开发页来源（.bat 走的就是它）会被
     * Blink 以「Media load rejected by URL safety check」直接拒收，实测
     * error.code 4、networkState 3、currentTime 永远 0 —— 播放器无限转圈，
     * 而文件本身、缓存、编解码都没有任何问题。
     */
    check('主进程注册了本地文件协议（tpf:），带 stream 与 Range', () => {
        assert(/registerSchemesAsPrivileged/.test(protocolSrc), '必须把自定义协议声明为 privileged');
        const i = protocolSrc.indexOf('registerSchemesAsPrivileged');
        const around = protocolSrc.slice(i, i + 600);
        assert(/stream:\s*true/.test(around),
            'stream 必须为 true：否则媒体元素拿不到流式读取，等于整段下载完才能播');
        assert(/standard:\s*true/.test(around), 'standard 为 true 才有正常的 host/path 解析');
        assert(/protocol\.handle\(\s*LOCAL_FILE_SCHEME/.test(protocolSrc), '要用 protocol.handle 供流');
        assert(/Content-Range/.test(protocolSrc) && /status:\s*206/.test(protocolSrc),
            '要实现 Range：媒体元素靠 206 分段定位，缺了它拖动进度条会直接停住');
        assert(/registerLocalFileProtocol\(\)/.test(main), '协议必须在 ready 之后真的注册');
    });

    check('渲染层赋 src 前把 file:// 换成可播协议', () => {
        assert(/video\.src = toPlayableUrl\(file\.url\)/.test(hook),
            'video.src 必须经过 toPlayableUrl —— 直接赋 file:// 在开发页来源下必然被拒收');
        assert(/src=\{toPlayableUrl\(currentFile\.url\)\}/.test(panel),
            '图片同理：保存后的图集页也是 file://');
    });

    check('toPlayableUrl 的映射与按来源无关', () => {
        const { toPlayableUrl, LOCAL_FILE_SCHEME } = require('./build/shared/core/media');
        const win = toPlayableUrl('file:///D:/a/b%20c.mp4');
        assert(win.startsWith(`${LOCAL_FILE_SCHEME}//local/`), `Windows 路径映射错误：${win}`);
        assert(decodeURIComponent(win.slice(win.indexOf('/local/') + 7)) === 'D:/a/b c.mp4',
            `路径必须能原样还原：${win}`);
        const posix = toPlayableUrl('file:///home/u/片 段.mp4');
        assert(decodeURIComponent(posix.slice(posix.indexOf('/local/') + 7)) === '/home/u/片 段.mp4',
            `POSIX 绝对路径的根不能丢：${posix}`);
        // 非本地来源一个字节都不许动：它们本来就能播
        assert(toPlayableUrl('https://a/b.m3u8') === 'https://a/b.m3u8', 'https 不该被改写');
        assert(toPlayableUrl('blob:https://a/x') === 'blob:https://a/x', 'blob 不该被改写');
    });

    check('渲染层与主进程用的是同一个协议名', () => {
        const { LOCAL_FILE_SCHEME } = require('./build/shared/core/media');
        // 主进程注册的是没有冒号的形式（protocol.handle 要裸 scheme），
        // 这里只比对名字本身：写错一个字母，本地文件会全部 404
        const bare = LOCAL_FILE_SCHEME.replace(/:$/, '');
        assert(new RegExp(`LOCAL_FILE_SCHEME = '${bare}'`).test(protocolSrc),
            `主进程该注册 '${bare}'，实际不是 —— 两边不一致时本地文件全部打不开`);
    });

    check('CSP 放行本地文件协议', () => {
        const html = read('app', 'index.html');
        assert(/media-src[^;]*tpf:/.test(html), 'media-src 要放行 tpf:');
        assert(/img-src[^;]*tpf:/.test(html), 'img-src 要放行 tpf:');
    });

    if (fails.length > 0) {
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  本地起播/窗口降频 ${pass} pass / ${fails.length} fail`);    return fails.length === 0;
};

module.exports = { run };
