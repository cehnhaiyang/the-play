'use strict';
/**
 * 代理配置的回归测试。
 *
 * 真实故障：媒体下载报 `HTTP error 403 Forbidden`。
 * 根因不是网络被封，而是 **ffmpeg 根本没走代理**：
 *   · 用户配的 10808 是 SOCKS5；
 *   · ffmpeg 的 `-http_proxy` 只认 HTTP 代理，SOCKS5 传进去会被忽略；
 *   · 原代码只在 `protocol === 'http'` 时才注入代理 → SOCKS5 用户等于裸直连，
 *     CDN 直接 403。而应用内播放走 Chromium 会话代理是好的，两边行为对不上。
 *
 * 设计：给用户**两个代理入口** —— SOCKS5 与 HTTP，各配各的。
 *   · 应用自身优先 SOCKS5（配了就用），否则用 HTTP；
 *   · ffmpeg 只能用 HTTP（协议限制），所以 HTTP 那一栏同时服务 ffmpeg。
 *
 * 刻意**不猜端口**：不探测 port+1/port+2、不从主代理推导 —— 那会把用户
 * 绑死在某个代理软件上。
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
const SETTINGS = path.join(__dirname, '..', 'app', 'main', 'settings.js');

const run = () => {
    const state = { pass: 0, fails: [] };
    const mainSrc = fs.readFileSync(MAIN, 'utf8');
    const settingsSrc = fs.readFileSync(SETTINGS, 'utf8');

    check('设置里是两个代理入口：SOCKS5 与 HTTP', () => {
        assert(/socksProxy:\s*''/.test(settingsSrc), 'settings 要有 socksProxy');
        assert(/httpProxy:\s*''/.test(settingsSrc), 'settings 要有 httpProxy');
        assert(/function saveSocksProxy/.test(settingsSrc), '要有 saveSocksProxy');
        assert(/function saveHttpProxy/.test(settingsSrc), '要有 saveHttpProxy');
        // 旧的单一 proxyPort / ffmpegProxy 必须消失
        assert(!/proxyPort:\s*''/.test(settingsSrc), '旧的单一 proxyPort 应已移除');
        assert(!/ffmpegProxy:\s*''/.test(settingsSrc), 'ffmpegProxy 这个名字不该再出现（就是 HTTP 代理）');
    }, state);

    check('应用自身：优先 SOCKS5，没有才用 HTTP', () => {
        assert(/socksProxy\s*\|\|\s*settings\.httpProxy/.test(mainSrc),
            '应用侧端点应按「SOCKS5 优先」选择');
    }, state);

    check('ffmpeg 用 HTTP 那一栏（不是"ffmpeg 专用"的第三项）', () => {
        assert(/setFfmpegHttpProxy\(httpForFfmpeg/.test(mainSrc),
            'ffmpeg 应从 httpProxy 取值');
        assert(/if \(ffmpegHttpProxy\)/.test(mainSrc), 'ffmpeg 参数应只看 ffmpegHttpProxy');
        assert(/'-http_proxy'/.test(mainSrc), '仍要传 -http_proxy');
        // 旧写法：按主代理协议判断，SOCKS5 用户会被漏掉
        assert(!/appliedProtocol\s*===\s*'http'/.test(mainSrc),
            'ffmpeg 不该再按主代理协议判断');
    }, state);

    check('只填 SOCKS5 时明确告知 ffmpeg 会直连', () => {
        assert(/只配了 SOCKS5/.test(mainSrc), '主进程日志要说明');
        assert(/ffmpeg 不支持 SOCKS5，媒体下载会直连/.test(
            fs.readFileSync(path.join(__dirname, '..', 'app', 'components', 'Floating.tsx'), 'utf8')),
            '界面要提示只填 SOCKS5 时媒体下载会直连');
    }, state);

    check('不猜配对端口（不能把用户绑死在某个代理软件上）', () => {
        assert(!/port\s*\+\s*1/.test(mainSrc), '不该探测 port+1');
        assert(!/port\s*\+\s*2/.test(mainSrc), '不该探测 port+2');
        assert(!/speaksHttpProxy/.test(mainSrc), '不该有"猜哪个端口是 HTTP"的逻辑');
        assert(!/resolveFfmpegProxy/.test(mainSrc), '不该从主代理推导');
    }, state);

    check('留空 = 不用；连不上回落直连（不阻断下载）', () => {
        assert(/function setFfmpegHttpProxy/.test(mainSrc), '要有 setFfmpegHttpProxy');
        assert(/if \(!parsed\) \{\s*\n\s*ffmpegHttpProxy = '';/.test(mainSrc),
            '空值必须清空 ffmpegHttpProxy');
        assert(/连不上/.test(mainSrc), '连不上时应回落并记日志');
    }, state);

    check('IPC 与 preload 都有两个入口', () => {
        assert(/ipcMain\.handle\('settings-set-socks-proxy'/.test(mainSrc), '要注册 socks 通道');
        assert(/ipcMain\.handle\('settings-set-http-proxy'/.test(mainSrc), '要注册 http 通道');
        const preload = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'preload.js'), 'utf8');
        assert(/setSocksProxy:/.test(preload), 'preload 要暴露 setSocksProxy');
        assert(/setHttpProxy:/.test(preload), 'preload 要暴露 setHttpProxy');
        assert(/socksProxy/.test(mainSrc) && /httpProxy/.test(mainSrc),
            'settings-get 要回传两份值');
    }, state);

    check('界面是两个并列输入框，不是一个"ffmpeg 专用"', () => {
        const ui = fs.readFileSync(path.join(__dirname, '..', 'app', 'components', 'Floating.tsx'), 'utf8');
        assert(/fp-socks-proxy/.test(ui), '要有 SOCKS5 输入框');
        assert(/fp-http-proxy/.test(ui), '要有 HTTP 输入框');
        assert(/SOCKS5 代理/.test(ui) && /HTTP 代理/.test(ui), '两个标签都要有');
        assert(!/fp-ffmpeg-proxy/.test(ui), '不该有"ffmpeg 专用代理"输入框');
        assert(!/ffmpeg 代理（仅 HTTP）/.test(ui), '不该把 HTTP 那一栏叫成 ffmpeg 代理');
        assert(/handleSaveSocks/.test(ui) && /handleSaveHttp/.test(ui), '各自独立的保存处理');
    }, state);

    check('启动时同步 ffmpeg 用的 HTTP 代理（重启后不丢）', () => {
        const sync = mainSrc.slice(mainSrc.indexOf('async function syncAcgmhoProxy'));
        const body = sync.slice(0, sync.indexOf('\n}\n'));
        assert(/setFfmpegHttpProxy\(/.test(body), 'syncAcgmhoProxy 必须同步 ffmpeg 代理');
    }, state);

    if (state.fails.length > 0) {
        for (const f of state.fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  代理配置 ${state.pass} pass / ${state.fails.length} fail`);
    return state.fails.length === 0;
};

module.exports = { run };
