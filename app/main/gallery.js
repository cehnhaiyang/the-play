'use strict';
/**
 * 画廊引擎：通用能力 + 站点注册表。
 *
 * 上半部是通用能力（出站请求、拦截页识别、图片落盘与续传、画廊目录产物、
 * 页码范围），**不允许出现任何站点名** —— 一旦写进来，下一个要接入的站点就得
 * 复制粘贴一遍这些逻辑。下半部是站点注册表，站点的差异（URL 形状、HTML 结构、
 * 字段口径）一律留在各自 provider 里，这里只做组装。
 *
 * 依赖方向与注册方式见下方「站点注册表」一节。
 * 本文件不维护出网逻辑：代理、隧道、agent 由 main.js 的全局网络层接管 ——
 * 这里照常写 https.get 就是走代理的。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

/* -------------------------------------------------------------------------- */
/*                              站点请求身份                                    */
/* -------------------------------------------------------------------------- */
// 抓取时使用的 UA 与默认请求头。
//
// UA 由 main.js 在启动时推入（`setUserAgent`）：它读引擎自己那一份
// （`app.userAgentFallback`，会话就绪后再对齐会话实际值）。这里**不自造** UA——
// cf_clearance 与 UA 绑定，Node 直抓必须与"拿到凭证的那个浏览器"完全一致，
// 自造一份就是两个来源，表现为"验证过了但搜索仍 403"。
//
// 本模块不 require electron：那会让它无法被 test/ 直接 require 求值。
const HEADERS = {
    'User-Agent': '',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 把 UA 换成浏览器会话的真实值（由 main.js 在启动与会话就绪后调用） */
function setUserAgent(value) {
    const next = String(value || '').trim();
    if (!next || next === HEADERS['User-Agent']) return false;
    HEADERS['User-Agent'] = next;
    return true;
}

function getUserAgent() {
    return HEADERS['User-Agent'];
}

/* -------------------------------------------------------------------------- */
/*                          站点网络策略（IP 钉住等）                            */
/* -------------------------------------------------------------------------- */
/**
 * 本文件保持站点无关：某个站点需要"连 IP、但 Host/SNI 仍用域名"这类特殊
 * 出口时，由站点模块注册一个策略函数，本文件只负责在发请求时应用它。
 *
 * 返回值形状：
 *   { headers?: object, host?: string, servername?: string, agent?: object }
 * - host：真正连接的 IP（URL 里的域名只用于拼路径），不填就走正常 DNS。
 * - servername：TLS SNI，必须与 Host 头一致，否则 CDN 认不出要哪个虚拟主机。
 * - agent：显式 agent；站点要绕过全局代理直连内置 IP 时在这里给直连 agent。
 *
 * 只影响本文件自己的请求；不碰 main.js 的全局 agent（其它出网路径照旧）。
 */
let siteNetworkPolicy = null;
function setSiteNetworkPolicy(fn) {
    siteNetworkPolicy = typeof fn === 'function' ? fn : null;
}
function networkOptionsFor(url) {
    return (siteNetworkPolicy && siteNetworkPolicy(url)) || {};
}
/**
 * 把策略里的 host/servername/agent 合进 Node 请求选项；headers 单独合。
 *
 * 关键：一旦要钉住 IP，就不能用 client.get(urlString, options) —— 现代 Node
 * 在同时给 URL 字符串与 options 时，URL 的 hostname 会覆盖 options.host，
 * 结果又去解析那个被污染的域名（实测连到错误 IP 超时）。必须改成 options-only：
 * 从 URL 拆出 path/port/protocol，host 用钉住的 IP。
 *
 * servername 要区分"没给"与"显式给空串"：空串是站点策略要求的"不发 SNI"
 * （域名前置），绝不能被 `if` 吞掉，否则 Node 会从 host 自动填 SNI，
 * 对新正则踩中 e-hentai 的 SNI 阻断。
 */
function requestTargetFor(url, headers, timeout, policy) {
    const options = { headers, timeout };
    if (policy.servername !== undefined && policy.servername !== null) {
        options.servername = policy.servername;
    }
    if (policy.agent !== undefined) options.agent = policy.agent;
    if (!policy.host) return { url, options };
    const parsed = new URL(url);
    options.protocol = parsed.protocol;
    options.hostname = policy.host;
    options.host = policy.host;
    options.port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    options.path = `${parsed.pathname}${parsed.search}`;
    // 钉住 IP 且无 SNI 时，Node 默认拿 host（IP）去校验证书 → IP 不在证书 CN/SAN 里，
    // 报 "Hostname/IP does not match certificate's altnames"。证书本是按域名签的，
    // 所以显式按 URL 域名校验（域名前置时也一样：无 SNI 拿到了 e-hentai 的证书）。
    options.checkServerIdentity = (hostname, cert) =>
        require('tls').checkServerIdentity(parsed.hostname, cert);
    // 策略没给 Host 头时补上原域名，避免钉住 IP 后 Host 变成 IP
    if (!headers.Host && !headers.host) headers.Host = parsed.hostname;
    return { url: null, options };
}

/* -------------------------------------------------------------------------- */
/*                                  工具                                       */
/* -------------------------------------------------------------------------- */
// 有限并发 worker 池：结果按输入顺序回填，调用方自行在 worker 内吞掉单项错误。
// 用途：fetch/download/save 的多页并发，进度由 worker 完成时各自上报。
function mapWithConcurrency(list, concurrency, worker) {
    const n = list.length;
    const out = new Array(n);
    let cursor = 0;
    const lanes = Math.min(Math.max(1, Number(concurrency) || 1), n);
    const runners = Array.from({ length: lanes }, async () => {
        while (true) {
            const i = cursor;
            cursor += 1;
            if (i >= n)
                return;
            out[i] = await worker(list[i], i);
        }
    });
    return Promise.all(runners).then(() => out);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function unescapeHtml(html) {
    return html
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#160;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function stripTags(s) {
    if (!s) return '';
    // 折叠连续空白：站点模板用大量缩进/换行排版标题，不折叠会得到
    // "标题\n                         - 原神…" 这类带大段空白的字符串，
    // 直接进播放列表/文件名（文件名里还会变成一串下划线）。
    return unescapeHtml(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/*                                  HTTP GET                                   */
/* -------------------------------------------------------------------------- */
/**
 * 抓取 HTML 并跟踪 302 最终地址：站内搜索 /q/xxx-N.html 会 302 到规范页
 * （如 /tags/sister.html），后续翻页必须基于规范地址，否则服务端永远回第 1 页。
 * extraHeaders：调用方可注入 Cookie（如 Electron 会话里的 Cloudflare 放行凭证），
 * 键与 HEADERS 冲突时调用方优先。
 */
function httpGetFinal(url, referer = null, timeout = 30000, retries = 3, redirects = 5, extraHeaders = null) {
    return new Promise((resolve, reject) => {
        // 链内 cookie jar：跳转链中途种下的 cookie（如 www 的会话标识）后续跳要带上，
        // 否则跨子域（www → search.acgmho.com）直接裸访，容易被风控 403。
        const jar = [];
        const rememberCookies = (setCookie) => {
            for (const c of setCookie || []) {
                const pair = String(c).split(';')[0].trim();
                if (!pair || !pair.includes('='))
                    continue;
                const name = pair.slice(0, pair.indexOf('='));
                const idx = jar.findIndex((j) => j.slice(0, j.indexOf('=')) === name);
                if (idx >= 0)
                    jar[idx] = pair;
                else
                    jar.push(pair);
            }
        };
        if (extraHeaders && extraHeaders.Cookie) {
            // Cookie 头是 "a=1; b=2" 拼串：必须按 ';' 拆成多项再记。
            // 之前整个串当一项塞进去，split(';')[0] 只留下第一个 cookie，
            // 主进程拼好的多凭证（cf_clearance + 会话）到链里只剩一个，搜索 403 雪上加霜。
            rememberCookies(String(extraHeaders.Cookie).split(';'));
        }
        function attempt(n, currentUrl, remaining) {
            // 站点级网络策略（如 e-hentai 的内置 IP 钉住）按当前 URL 现取：
            // 跳转会换域名，钉住只对该站点自己的域名生效，别一路带到别的域。
            const policy = networkOptionsFor(currentUrl);
            const headers = { ...HEADERS, ...(policy.headers || {}), ...(extraHeaders || {}) };
            delete headers.Cookie;
            if (referer) {
                headers.Referer = referer;
            }
            if (jar.length) {
                headers.Cookie = jar.join('; ');
            }
            // 单次尝试的收尾守卫：超时、连接错误、响应中断会在同一毫秒内接连触发多个事件
            // （实测 truncate: res.aborted + res.error + res.close 同帧到达；slow: req.timeout
            // 紧跟 req.error）。此前每个事件各自排一次重试，请求数按 2^n 放大——retries=3
            // 实测打出 7 个请求，站点限流正是被自己触发的，用户看到 429/"搜索过于频繁"。
            // settled 保证一次尝试只结算一次：要么成功、要么排一次重试、要么报错。
            let settled = false;
            const fail = (err) => {
                if (settled)
                    return;
                settled = true;
                // 代理配置类错误（端口不是 SOCKS5、要求认证、密码错）重试多少次结果都一样，
                // 只会把一句明确的话拖成 15 秒 ×3 的干等。直接给结论，让用户去改配置。
                if (err && err.proxyConfigError) {
                    reject(err);
                    return;
                }
                if (n < retries) {
                    setTimeout(() => attempt(n + 1, currentUrl, remaining), 1000 * n);
                }
                else {
                    reject(err);
                }
            };
            const giveUp = (err) => {
                if (settled)
                    return;
                settled = true;
                reject(err);
            };
            const client = currentUrl.startsWith('https:') ? https : http;
            // 不传 agent：main.js 的全局网络层已把 http/https 的 globalAgent
            // 换成隧道 agent，这里照常写就自动走代理。
            // 站点策略可钉住 IP：此时必须用 options-only（见 requestTargetFor），
            // 否则 URL 域名会盖掉 options.host，又回到污染 DNS。
            const target = requestTargetFor(currentUrl, headers, timeout, policy);
            // 钉住 IP 时必须走 options-only（传 null 会让 Node 把 null 当 URL 解析），
            // 正常路径仍保留 URL 字符串以沿用既有的跳转/编码行为。
            const req = policy.host
                ? client.get(target.options, (res) => onResponse(res))
                : client.get(currentUrl, target.options, (res) => onResponse(res));
            function onResponse(res) {
                rememberCookies(res.headers['set-cookie']);
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    if (remaining <= 0) {
                        res.resume();
                        giveUp(new Error(`重定向次数过多: ${currentUrl}`));
                        return;
                    }
                    // 中文站 Location 常带未编码的原始 UTF-8（如 /q/汤…-1-<md5>.html）：
                    // Node http 头按 latin1 给字符串，直接 new URL 会把"UTF-8 字节误读成 latin1 字符"
                    // 再百分编码一次（%E6%B9%AF → %C3%A6…），搜索子域对这类坏 URL 直接 403。
                    // 先按 latin1 还原字节、按 UTF-8 解码；已编码的纯 ASCII 路径不受影响。
                    const location = Buffer.from(String(res.headers.location), 'latin1').toString('utf-8');
                    const redirectUrl = new URL(location, currentUrl).toString();
                    res.resume();
                    // 已交接给下一跳：本跳任何后到事件都不再结算，避免与跳转链抢 resolve/reject
                    settled = true;
                    attempt(n, redirectUrl, remaining - 1);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    // 4xx 不重试：404 是资源不存在、403 是风控/挑战拦路，重试只会白等退避时间。
                    // 之前全状态都重试：auto 探测 8 候选 × 3 次 × 退避，死 gid 一次探测被拖慢数十秒。
                    // 408（超时）/429（限流）与 5xx 例外，仍按退避重试。
                    const retryable = res.statusCode === 408 || res.statusCode === 429 || res.statusCode >= 500;
                    if (retryable)
                        fail(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
                    else
                        giveUp(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
                    return;
                }
                const chunks = [];
                let received = 0;
                const MAX_BODY = 10 * 1024 * 1024;
                res.on('data', (c) => {
                    received += c.length;
                    if (received > MAX_BODY) {
                        req.destroy();
                        giveUp(new Error(`响应过大，已中断: ${currentUrl}`));
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => {
                    if (settled)
                        return;
                    settled = true;
                    resolve({ html: Buffer.concat(chunks).toString('utf-8'), url: currentUrl });
                });
                // 响应中途断流（代理/VPN 掉线、服务端提前关闭）：req 不报错，只在 res 上体现。
                // 此前没有任何 res 级错误监听，promise 永不结算 → 频道列表/探测/抓页整个挂死，
                // UI 一直转圈且没有任何报错（搜索路径 20s 竞速兜底也救不了非搜索频道）。
                res.on('error', (err) => fail(err));
                // close 是必然事件：complete=false 说明响应被截断，用它兜住 aborted/未捕获的断流
                res.on('close', () => {
                    if (!res.complete)
                        fail(new Error(`响应被中断（连接提前关闭）: ${currentUrl}`));
                });
            }
            req.on('timeout', () => {
                req.destroy();
                fail(new Error(`Timeout fetching ${currentUrl}`));
            });
            req.on('error', (err) => {
                fail(err);
            });
        }
        attempt(1, url, redirects);
    });
}
function httpGet(url, referer = null, timeout = 30000, retries = 3, redirects = 5) {
    return httpGetFinal(url, referer, timeout, retries, redirects).then((r) => r.html);
}

/* -------------------------------------------------------------------------- */
/*                          Cloudflare 拦截页识别                               */
/* -------------------------------------------------------------------------- */
// Cloudflare managed 挑战页识别。挑战页标题随语言变化（英文 "Just a moment..."、
// 中文 "请稍候…"），单查英文标题会漏判；该页还带挑战脚本标记与验证文案，
// 两者结合判定。命中即"这不是结果页"，必须报错而不是解析成 0 条。
const CF_CHALLENGE_SCRIPT_RE = /_cf_chl_opt|cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i;
const CF_CHALLENGE_TEXT_RE =
    /just a moment|请稍候|安全验证|正在验证|正在进行安全验证|checking your browser|attention required|verify you are human/i;
function isCloudflareChallengePage(html) {
    if (!html) return false;
    return CF_CHALLENGE_SCRIPT_RE.test(html) && CF_CHALLENGE_TEXT_RE.test(html);
}

// Cloudflare 5xx 错误页（如 520 origin 挂掉）不是结果页也不是挑战页：
// 误收会导致"解析出 0 条 → 未找到"，比挑战页更隐蔽。
const CF_ERROR_TEXT_RE =
    /web server is returning|error code \d{3}|bad gateway|gateway time-?out|origin is unreachable|未知错误/i;
function isCloudflareErrorPage(html) {
    if (!html) return false;
    return CF_ERROR_TEXT_RE.test(html) && /cloudflare|cdn-cgi/i.test(html);
}

/**
 * E-Hentai 的限流/封禁页：HTTP 200 的纯文本，不是 HTML。
 *
 * 实测（2026-10）直连和代理共用 IP 被限流时，站点返回 200 + 242 字节：
 *   "This IP address has been temporarily banned due to an excessive request rate. ...
 *    The ban expires in 52 minutes and 7 seconds"
 * 没有 <html>、没有 <table class="itg">，旧代码会把这页当"站点结构变了"或
 * "没搜到"，用户按提示去反馈改版，实际只是 IP 被临时封了。
 * 这里把这类页面单独识别出来，返回一个能据以行动的原因（含官方给出的到期时间）。
 */
const EH_BAN_TEXT_RE =
    /temporarily banned|excessive request rate|automated mirroring|ban expires in|Your IP address has been banned/i;
const EH_LIMIT_TEXT_RE =
    /image limit|You are opening pages too fast|exceeded your|gallery limit/i;
function ehentaiBlockReason(html) {
    if (!html) return null;
    if (EH_BAN_TEXT_RE.test(html)) {
        const m = html.match(/ban expires in\s+([\d\s]+?\s*(?:minutes?|seconds?|hours?))/i);
        const when = m ? `（约 ${m[1].trim()} 后）` : '';
        return `站点提示：当前 IP 因请求过于频繁被临时封禁${when}，请等待解封或减少并发、检查代理后重试`;
    }
    if (EH_LIMIT_TEXT_RE.test(html)) {
        return '站点提示：触发了看图/请求配额限制（image limit），请等几分钟后重试';
    }
    return null;
}

/* -------------------------------------------------------------------------- */
/*                              图片落盘（可续传）                              */
/* -------------------------------------------------------------------------- */
// 单页图片下载的两道时限：IDLE 管"对端不发数据"，TOTAL 管"对端一直在发但永远发不完"。
// 单页图片通常几十 KB~几 MB，5 分钟总时限对慢速链路仍有余量。
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 下载单页图片，支持 .part 断点续传。
 *
 * 不传 agent：main.js 的全局网络层已接管 globalAgent，图片请求与站点页一样走代理。
 * 曾按"图床必须直连"给它加过 agent 参数，实测不成立 —— hath.network 经 HTTP 代理
 * 10810 与 SOCKS5 10808 都能拿全图（与直连同样的字节数），那条特例是误判，
 * 留着只会让"某条路径忘了传 agent"变成静默的直连漏网。
 *
 * @param {string} url 图片直链
 * @param {string} dest 目标文件（不含 .part）
 * @param {string|null} referer 防盗链来源页
 * @param {(done:number,total:number)=>void} [onChunk] 进度回调
 */
function downloadImageWithResume(url, dest, referer, onChunk) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            resolve(fs.statSync(dest).size);
            return;
        }

        const part = dest + '.part';
        const resume = fs.existsSync(part);
        let pos = resume ? fs.statSync(part).size : 0;

        const headers = { ...HEADERS };
        if (referer) headers.Referer = referer;
        if (pos > 0) headers.Range = `bytes=${pos}-`;

        const client = url.startsWith('https:') ? https : http;
        // 写盘流提至外层：网络错误/超时时一并销毁，否则 fd 泄漏；
        // 写盘流自身错误（如磁盘满）也要接住，否则触发 unhandled 'error' 直接崩进程
        let fileStream = null;
        let req = null;
        let settled = false;
        // 双重看门狗。req 的 timeout 是"空闲超时"，对端只要还在滴流就永不触发：
        // 实测服务端挂死但保持连接时，这一页会永久占住一个并发位，整本下载卡住
        // 既不完成也不报错。因此按"距上次收到数据"独立计时（IDLE），
        // 并额外设一道总时限（TOTAL）兜住"每 3s 一个字节"这类永不空闲的滴流。
        let idleTimer = null;
        let totalTimer = null;
        const clearWatchdogs = () => {
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearWatchdogs();
            try { if (fileStream) fileStream.destroy(); } catch (_e) { /* ignore */ }
            try { if (req) req.destroy(); } catch (_e) { /* ignore */ }
            reject(err);
        };
        const kickIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                fail(new Error(`下载停滞超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s（对端无数据）: ${url}`));
            }, DOWNLOAD_IDLE_TIMEOUT_MS);
        };
        const armTotal = () => {
            totalTimer = setTimeout(() => {
                fail(new Error(`下载超过总时限 ${DOWNLOAD_TOTAL_TIMEOUT_MS / 1000}s 仍未完成: ${url}`));
            }, DOWNLOAD_TOTAL_TIMEOUT_MS);
        };
        const requestOptions = { headers, timeout: 120000 };
        req = client.get(url, requestOptions, (res) => {
            // 连接已建立：看门狗按"收到数据"续期，覆盖"连上后对端不再发数据"的挂死
            kickIdle();
            armTotal();
            // 416：Range 起点已到/超过文件末尾，说明 .part 其实已经收全（上次写完后
            // 在 rename 前被打断/崩溃，或服务端刚改小了文件）。此时必须把 .part 补完为
            // 正式文件——此前一律当失败抛出，且下一轮 Range 仍是同一位置，同一页永远
            // 下载失败、永远重试，用户看到"下载失败"卡死且目录里留着一个无法收敛的 .part。
            if (res.statusCode === 416 && pos > 0) {
                res.resume();
                if (settled) return;
                settled = true;
                clearWatchdogs();
                try {
                    fs.renameSync(part, dest);
                    resolve(fs.statSync(dest).size);
                } catch (renameErr) {
                    reject(renameErr);
                }
                return;
            }

            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).toString();
                res.resume();
                // 已超时 settled 的话不再起新下载：否则旧 promise 已 reject，
                // 内层下载还在后台写文件，变孤儿写盘
                if (settled) return;
                downloadImageWithResume(redirectUrl, dest, referer, onChunk).then(resolve).catch(reject);
                return;
            }

            // 错误页（403/404 欠费图等）按失败抛错：之前会把 HTML 错误页存成 .webp 坏图。
            // 走 fail 而非裸 reject：统一 settled 守卫，后到的 res end/error 不再重复结算
            if (!res.statusCode || res.statusCode >= 400) {
                res.resume();
                fail(new Error(`HTTP ${res.statusCode || '未知'} downloading ${url}`));
                return;
            }
            // 206 续传/200 全量之外（如 204/304 无内容）同样视为失败，避免落盘 0 字节坏图
            if (res.statusCode !== 200 && res.statusCode !== 206) {
                res.resume();
                fail(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                return;
            }

            // 软 404：CDN 对不存在的图回 200 + text/html 错误页（实测站点图床如此）。
            // 此前只判 HTTP 状态码，于是把 HTML 错误页当图片写进 1.webp 并计入"成功页"，
            // 用户拿到一本每页都是 0 字节坏图的画廊，且下载报告显示全部成功。
            const ctype = String(res.headers['content-type'] || '').toLowerCase();
            if (ctype.includes('text/html') || ctype.includes('application/json')) {
                res.resume();
                fail(new Error(`图床返回了网页而非图片（Content-Type: ${ctype.split(';')[0]}）: ${url}`));
                return;
            }

            if (pos > 0 && res.statusCode === 200) {
                // 服务端不支持 Range（回 200 全量）：续传位置作废，从头写
                pos = 0;
            }

            const contentLength = parseInt(res.headers['content-length'] || '0', 10);
            const totalBytes = contentLength + pos;
            let doneBytes = pos;

            fileStream = fs.createWriteStream(part, { flags: pos > 0 ? 'a' : 'w' });
            fileStream.on('error', (err) => {
                try { res.destroy(); } catch (_e) { /* ignore */ }
                fail(err);
            });

            res.on('data', (chunk) => {
                kickIdle();
                fileStream.write(chunk);
                doneBytes += chunk.length;
                if (onChunk) {
                    onChunk(doneBytes, totalBytes);
                }
            });

            res.on('end', () => {
                if (settled) return;
                fileStream.end(() => {
                    if (settled) return;
                    settled = true;
                    clearWatchdogs();
                    try {
                        // 0 字节响应（图床偶发返回空体）不能算成功：此前会 rename 出 0 字节页文件
                        // 并 resolve(0)，上层把空文件留在画廊目录里，导入时该页是坏图；
                        // 且下次任务因 dest.size > 0 不成立会重下，形成"时好时坏"的页。
                        const size = fs.statSync(part).size;
                        if (size === 0) {
                            fs.unlinkSync(part);
                            reject(new Error(`图床返回了空响应（0 字节）: ${url}`));
                            return;
                        }
                        // 截断校验：声明了 Content-Length 却少收字节，说明连接是被"干净关闭"
                        // （FIN 而非 RST）截断的——res 不报 aborted，Node 直接发 end。
                        // 不校验就会把半张图当完整页 rename 成正式文件并计入"成功页"，
                        // 用户在画廊里看到下半截是灰色的破图。.part 保留，下轮 Range 续传补齐。
                        if (contentLength > 0 && size < totalBytes) {
                            reject(new Error(`响应被截断（收到 ${size}/${totalBytes} 字节），已保留断点待续传: ${url}`));
                            return;
                        }
                        fs.renameSync(part, dest);
                        resolve(fs.statSync(dest).size);
                    } catch (renameErr) {
                        reject(renameErr);
                    }
                });
            });

            res.on('error', (err) => {
                fail(err);
            });
        });

        req.on('error', (err) => {
            fail(err);
        });
        req.on('timeout', () => {
            fail(new Error(`Timeout downloading ${url}`));
        });
    });
}

/* -------------------------------------------------------------------------- */
/*                             画廊目录产物                                     */
/* -------------------------------------------------------------------------- */
/**
 * 所有下载资源的根目录：项目根下的 `resource`（开发态即 D:\the-play\resource）。
 *
 * 为什么不用系统"下载"目录：这些是本应用自己的数据（画廊、音视频、种子），
 * 混进用户的下载文件夹既不好找，也容易被清理工具当成垃圾扫掉。
 *
 * 打包后项目目录在 app.asar 内不可写，回落到 userData/resource。
 * 非 Electron 环境（测试）回落到 ~/the-play/resource，保证纯函数可跑。
 */
function resourceRoot() {
    try {
        const { app } = require('electron');
        if (app) {
            return app.isPackaged
                ? path.join(app.getPath('userData'), 'resource')
                : path.join(app.getAppPath(), 'resource');
        }
    } catch (_e) { /* 非 Electron 或未就绪，走回退 */ }
    return path.join(os.homedir() || process.env.USERPROFILE || '.', 'the-play', 'resource');
}

// rootName 按站点分目录（acgmho / ehentai）：不同站点的 gid 空间互不相干，
// 混在同一层里同号作品会撞名互踩。
function defaultGalleryRoot(rootName, gid, prefix) {
    const base = resourceRoot();
    // 目录带前缀：同站 /h/123 与 /hentai/123 是两本不同的作品，同目录会互踩数字页文件
    // （pruneSiblingPageFiles 会删掉对方同页文件）且 manifest/.gallery 互盖。
    // 旧版无前缀目录保持不动（徽标齐全仍可导入），新任务走前缀目录。
    // gid/prefix 落盘前再净化一次：normalizeGid 已保证 gid 是纯数字，
    // 但 saveImages 允许调用方直传 gid，路径分隔符必须在这里彻底挡死。
    const p = String(prefix || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const safeGid = String(gid || '').replace(/[^0-9a-z_-]/gi, '');
    const leaf = p && p !== 'auto' ? `${p}-${safeGid}` : safeGid;
    return path.join(base, String(rootName || 'gallery'), leaf);
}

// 写新徽标前清掉同目录残留的旧徽标：改名重存时旧“<旧标题>.gallery”
// 会一直留着，导致导入时一本画廊认出两个名
function pruneStaleMarkers(galleryDir, keepFileName) {
    let entries = [];
    try {
        entries = fs.readdirSync(galleryDir);
    } catch (_e) {
        return;
    }
    for (const name of entries) {
        if (!/\.gallery$/i.test(name) || name === keepFileName) continue;
        try {
            fs.unlinkSync(path.join(galleryDir, name));
        } catch (_e) { /* ignore */ }
    }
}
function sanitizeTitle(name, fallback) {
    const clean = String(name || fallback || 'gallery')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return clean || String(fallback || 'gallery');
}

// 落盘输出二件套：manifest.json（旧脚本/旧目录兼容）+ <标题>.gallery 徽标（可导入画廊标识）。
// 各站点的 downloadGallery 与 saveImages 共用，字段口径唯一，不再两处各写一遍改漏。
// 清单写坏不致命（页文件才是本体，下次任务重写），吞错不停任务；徽标失败记日志。
function writeGalleryOutputs(galleryDir, { site = '', base = '', gid, title, prefix, sourceUrl = '', totalPages, records = [], logTag = 'gallery' }) {
    const now = new Date().toISOString();
    const manifestPath = path.join(galleryDir, 'manifest.json');
    try {
        fs.writeFileSync(
            manifestPath,
            JSON.stringify(
                { gid: String(gid), title, base, downloadedAt: now, records },
                null,
                2
            ),
            'utf-8'
        );
    } catch (_e) { /* 清单写坏不影响已落盘的页文件 */ }

    const markerName = `${sanitizeTitle(title, gid)}.gallery`;
    // 改名重存时清掉同目录旧徽标，否则一本画廊认出两个名
    pruneStaleMarkers(galleryDir, markerName);
    const galleryMarkerPath = path.join(galleryDir, markerName);
    try {
        fs.writeFileSync(
            galleryMarkerPath,
            JSON.stringify(
                {
                    format: 'the-play-gallery/1',
                    // site 让导入侧知道这本属于哪个站点（同号 gid 在两个站点是两本书）
                    site,
                    title,
                    gid: String(gid),
                    prefix,
                    sourceUrl,
                    totalPages,
                    createdAt: now,
                },
                null,
                2
            ),
            'utf-8'
        );
    } catch (markerErr) {
        console.error(`[${logTag}] 写入画廊徽标失败:`, markerErr && markerErr.message);
    }
    return { manifestPath, galleryMarkerPath };
}

// 同页换后缀清理：站点图片格式变更（webp 改 jpg）时，旧 `1.webp` 会和新 `1.jpg`
// 并存，导入时同一页码出现两次。落盘前删掉同页其他后缀的旧文件
function pruneSiblingPageFiles(galleryDir, pageNum, keepFileName) {
    const n = Number(pageNum);
    if (!Number.isFinite(n) || n < 1) return;
    let entries = [];
    try {
        entries = fs.readdirSync(galleryDir);
    } catch (_e) {
        return;
    }
    const siblingRe = new RegExp(`^${n}\\.[a-z0-9]+$`, 'i');
    for (const name of entries) {
        if (name === keepFileName || !siblingRe.test(name)) continue;
        if (!/\.(webp|jpe?g|png|gif|avif|bmp|heic)$/i.test(name)) continue;
        try {
            fs.unlinkSync(path.join(galleryDir, name));
        } catch (_e) { /* ignore */ }
    }
}

/* -------------------------------------------------------------------------- */
/*                                页码范围                                     */
/* -------------------------------------------------------------------------- */
function parsePageRange(spec, totalPages) {
    // 总页数必须归一为有限正整数：探测异常时上游可能传 null/undefined/NaN，
    // 此前 'all' 分支会走 Array.from({length: null}) → 空数组，
    // 下载静默变成"0 页"（用户点全本下载什么都没发生，也没有报错）。
    const total = Number.isFinite(Number(totalPages)) && Number(totalPages) > 0
        ? Math.floor(Number(totalPages))
        : 0;
    // 归一化必须先 trim 再判空。原来判的是 `!spec`（只挡 null/undefined/''），
    // 于是**纯空白**的 spec（' '、'\t'）会掉进下面的 split 分支：
    // 每段 trim 后都是空串被 continue 掉，最终返回空数组 —— 同样是"0 页、无报错"。
    // 渲染层有个同名同语义的 rangeIncludesPage（GalleryPanel），它把纯空白当"全选"，
    // 两边就此分叉：UI 认为在抓全部，主进程一页都不抓。
    // 目前渲染层总会先 trim 成 `1-${total}` 再传（见 handleFetchPages），
    // 所以还没炸；但这条 IPC 边界不保证调用方一定归一化，靠调用方自觉太脆。
    // 在这里统一按"空 = 全部"处理，两边语义重新对齐。
    const normalized = typeof spec === 'string' ? spec.trim() : '';
    if (!normalized || normalized.toLowerCase() === 'all') {
        return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = new Set();
    const chunks = normalized.split(',');
    for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        if (trimmed.includes('-')) {
            const [startStr, endStr] = trimmed.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
                    if (i >= 1 && i <= total) pages.add(i);
                }
            }
        } else {
            const num = parseInt(trimmed, 10);
            if (!isNaN(num) && num >= 1 && num <= total) pages.add(num);
        }
    }
    return Array.from(pages).sort((a, b) => a - b);
}

/* -------------------------------------------------------------------------- */
/*                                站点注册表                                    */
/* -------------------------------------------------------------------------- */
/*
 * 依赖方向（只有这一条，不允许反向）：
 *
 *     站点 provider（acgmhoService / ehentaiService）
 *              ↓ require
 *           gallery.js（本文件）
 *
 * 本文件**从不 require 任何 provider**，provider 在自己模块末尾调用
 * `registerProvider(module.exports)` 登记自己。若反过来让本文件 require provider，
 * 就成 gallery → provider → gallery 的环：两边在加载期互相拿到对方的半成品
 * （空对象或 undefined 的解构值），且失败点离原因很远。
 *
 * 代价：组合根必须显式加载各 provider（见 main.js 顶部）。漏加载不会静默 ——
 * 注册表为空时 requireSites() 会明确报错。
 */

/** 已注册站点（normalize 后的统一形状），顺序即 UI 里的站点顺序 */
const siteRegistry = [];
const registeredIds = new Set();

/**
 * 把各 provider 的差异收敛成一份统一形状。
 *
 * 差异只有两处，都只是命名不同，不值得为此改 provider：
 * - acgmho 的落盘入口叫 saveGalleryImages，ehentai 叫 saveImages；
 * - acgmho 的任务键与 gid 归一拆成 galleryTaskKey/normalizeGid 两个函数。
 * 这里补齐，调用方只认统一名。
 */
const normalizeProvider = (p) => {
    const saveImages = p.saveImages || p.saveGalleryImages;
    if (typeof saveImages !== 'function') {
        throw new Error(`站点 ${p.id} 缺少落盘入口（saveImages / saveGalleryImages）`);
    }
    if (typeof p.probeGallery !== 'function') throw new Error(`站点 ${p.id} 缺少 probeGallery`);
    if (typeof p.fetchGalleryPages !== 'function') throw new Error(`站点 ${p.id} 缺少 fetchGalleryPages`);
    if (typeof p.fetchChannelList !== 'function') throw new Error(`站点 ${p.id} 缺少 fetchChannelList`);
    if (typeof p.channels !== 'function') throw new Error(`站点 ${p.id} 缺少 channels()`);
    // 纯数字 gid 归一必须由 provider 提供：registry 无法凭 URL 形状反推"这个站点
    // 接受哪些写法"（ehentai 认 /g/<gid>/<token>/，acgmho 认 /h/<gid>.html 与裸数字）。
    // 缺了它，取消判定与落盘目录都会拿到空 gid，退化成把任务键当 gid 用。
    if (typeof p.normalizeGid !== 'function') throw new Error(`站点 ${p.id} 缺少 normalizeGid`);

    const rawTaskKeyOf = p.taskKeyOf || ((gidOrUrl, probe) => p.galleryTaskKey(gidOrUrl, probe));
    const rawKeyMatches = p.keyMatches || p.galleryKeyMatches;
    const gidOf = (input) => String((p.normalizeGid(input) || {}).gid || '').trim();

    /**
     * 任务键统一带站点前缀：`<site>:<站点内键>`。
     *
     * 站点内键由 provider 决定（acgmho 是 `prefix:gid`，ehentai 是纯 gid），
     * 但**站点维度由这里加**，不让每个 provider 各记一遍 —— 否则接第三个站点时
     * 又会出现一个忘了加前缀的键，表现为"两个站点同号作品互相顶掉"。
     */
    const taskKeyOf = (gidOrUrl, probe) => {
        const raw = String(rawTaskKeyOf(gidOrUrl, probe) || '').trim();
        if (!raw) return '';
        return raw.startsWith(`${p.id}:`) ? raw : `${p.id}:${raw}`;
    };

    /**
     * 取消/归属判定：先剥掉站点前缀再交给 provider。
     * 这样 provider 只关心"站点内这个键是不是这本书"，不用知道多站点存在。
     */
    const keyMatches = (storedKey, gidOrUrl) => {
        const raw = String(storedKey || '');
        if (!raw) return false;
        if (!raw.startsWith(`${p.id}:`)) return false;
        return !!rawKeyMatches(raw.slice(p.id.length + 1), gidOrUrl);
    };

    return {
        id: p.id,
        label: p.label,
        rootName: p.rootName || p.id,
        adult: !!p.adult,
        kinds: p.kinds || ['image'],
        /**
         * 搜索凭证的取用域：主进程据此从 Electron 会话里捞 cf_clearance 之类的
         * cookie。**必须按站点给**，不能让主进程拿一个站点的 cookie 去打另一个站点 ——
         * 那既是凭证跨站泄漏，也必然无效（cookie 按域签发）。
         */
        searchCookieOrigins: p.searchCookieOrigins || [],
        channels: p.channels,
        fetchChannelList: p.fetchChannelList,
        probeGallery: p.probeGallery,
        fetchGalleryPages: p.fetchGalleryPages,
        saveImages,
        downloadGallery: p.downloadGallery,
        /**
         * 可选能力：把"页面给出的流地址"换成"下载器能直接取到流的地址"。
         * 只有带流媒体的站点需要（有的图床按层签名，下载器解析相对地址会丢签名）。
         * 缺省为 null = 本站不接管，调用方用原地址。
         */
        resolveStreamSource: typeof p.resolveStreamSource === 'function' ? p.resolveStreamSource : null,
        taskKeyOf,
        gidOf,
        keyMatches,
    };
};

/**
 * 注册一个站点 provider（由 provider 自己在模块末尾调用）。
 *
 * 幂等：同一个 id 重复注册直接忽略。这很重要 —— provider 可能被多处 require，
 * 而且测试会重复加载模块，重复注册会让站点表里出现两份同名站点。
 */
function registerProvider(provider) {
    if (!provider || !provider.id) {
        throw new Error('registerProvider 需要一个带 id 的 provider');
    }
    const id = String(provider.id);
    if (registeredIds.has(id)) return false;
    siteRegistry.push(normalizeProvider(provider));
    registeredIds.add(id);
    return true;
}

/** 取已注册的站点；一个都没有时报错，不静默返回空表（否则缺站点毫无提示） */
function requireSites() {
    if (siteRegistry.length === 0) {
        throw new Error(
            '没有已注册的站点：各 provider 必须在使用注册表前被 require'
            + '（它们会在模块末尾调用 gallery.registerProvider 注册自己）。'
            + '主进程的组合根在 main.js 顶部。'
        );
    }
    return siteRegistry;
}

const DEFAULT_SITE_ID = 'acgmho';

/** 站点列表（UI 的站点切换按它渲染；不含任何解析细节） */
const listSites = () => requireSites().map((p) => ({
    id: p.id,
    label: p.label,
    adult: p.adult,
    kinds: p.kinds,
}));

/**
 * 按 id 取站点。
 *
 * 不传 id 时回落到默认站点（老调用方没带 site 字段，行为保持不变）；
 * 传了但认不出就抛错 —— 静默回落会让"站点名打错"变成"打开了另一个站点"。
 */
const getSite = (id) => {
    const want = String(id || '').trim();
    const providers = requireSites();
    if (!want) return providers.find((p) => p.id === DEFAULT_SITE_ID) || providers[0];
    const found = providers.find((p) => p.id === want);
    if (!found) throw new Error(`未知站点: ${want}（可选：${providers.map((p) => p.id).join(' / ')}）`);
    return found;
};

/**
 * 任务键 → 站点。
 *
 * 键的形态是 `<site>:<...>`。旧任务键没有站点前缀（如 `h:123`、`123`），
 * 一律归 acgmho —— 那时只有它一个站点，这样历史任务与取消路径都还能用。
 */
const siteOfTaskKey = (key) => {
    const raw = String(key || '');
    const head = raw.split('#')[0].split(':')[0];
    const providers = requireSites();
    const found = providers.find((p) => p.id === head);
    return found || providers.find((p) => p.id === DEFAULT_SITE_ID) || providers[0];
};

/**
 * 站点内全部频道的扁平表，供 UI 一次性拿到"站点 → 频道"两层结构。
 * 频道 id 只在站点内唯一（latest/popular 这类名字两个站点都会用），
 * 所以对外的复合键必须是 `site:channelId`。
 */
const listChannels = () => requireSites().map((p) => ({
    site: p.id,
    label: p.label,
    adult: p.adult,
    channels: p.channels().map((c) => ({ ...c })),
}));

/**
 * 流地址 → 下载器能直接取流的地址。
 *
 * 注册表只负责"问谁"：按注册顺序交给各站点，谁接管（返回非空）就用谁的结论。
 * 没人接管时**原样返回** —— 改写本身可能打乱别的 CDN 的缓存键或签名。
 * 站点自己的签名规则不从注册表推导：那是站点知识，注册表无从得知。
 */
async function resolveStreamSource(url) {
    const raw = String(url || '');
    if (!raw) return raw;
    for (const p of requireSites()) {
        if (!p.resolveStreamSource) continue;
        const mapped = await p.resolveStreamSource(raw);
        if (mapped) return mapped;
    }
    return raw;
}

/* -------------------------------------------------------------------------- */
/*                              落盘收尾口径                                    */
/* -------------------------------------------------------------------------- */
/**
 * 保存结束时的 status / message —— 三个落盘入口（图集两站 + 媒体）共用。
 *
 * 为什么必须统一：这三处原先各写一遍
 *     status: cancelled ? 'cancelled' : 'completed'
 * 于是**一个文件都没存下时也发 completed**，界面照常打绿勾、写
 * "保存完成：成功 0/1 页"，进度条停在 0。用户看到的是"成功"，磁盘上是空的，
 * 而失败原因（403/超时/断流）只进了 records，界面上一个字都没有。
 *
 * 现在的口径：
 *   · 取消          → cancelled
 *   · 0 个成功      → **error**（不是 completed），消息带上首个失败原因
 *   · 部分失败      → completed，但消息写明失败数量与首个原因
 *   · 全部成功      → completed
 *
 * @param {object} o
 * @param {number} o.savedCount   成功落盘的文件数
 * @param {number} o.totalFiles   计划落盘的文件数
 * @param {boolean} [o.cancelled] 是否被用户取消
 * @param {Array<{error?: string}|string>} [o.errors] 失败项（取第一个原因）
 * @param {string} [o.unit]       计数单位（图集用「页」，媒体用「个文件」）
 */
function saveOutcome({ savedCount, totalFiles, cancelled = false, errors = [], unit = '页' }) {
    if (cancelled) return { status: 'cancelled', message: '保存已取消' };
    const list = Array.isArray(errors) ? errors : [];
    const firstError = String(
        (list[0] && (list[0].error || list[0])) || ''
    ).trim().slice(0, 400);
    const reason = firstError ? `（${firstError}）` : '';
    const total = Number(totalFiles) || 0;
    const saved = Number(savedCount) || 0;

    // 一个都没成功：这不是"完成"，是彻底失败，必须让界面显示成错误
    if (saved === 0) {
        return {
            status: 'error',
            message: total > 0
                ? `保存失败：0/${total} ${unit}${reason}`
                : `保存失败${reason}`,
        };
    }
    if (list.length > 0) {
        return {
            status: 'completed',
            message: `保存完成：成功 ${saved}/${total} ${unit}，${list.length} ${unit}失败${reason}`,
        };
    }
    return { status: 'completed', message: `保存完成：成功 ${saved}/${total} ${unit}` };
}

module.exports = {
    /* ---- 通用能力 ---- */
    HEADERS,
    setUserAgent,
    getUserAgent,
    mapWithConcurrency,
    sleep,
    unescapeHtml,
    stripTags,
    httpGetFinal,
    httpGet,
    isCloudflareChallengePage,
    isCloudflareErrorPage,
    ehentaiBlockReason,
    setSiteNetworkPolicy,
    DOWNLOAD_IDLE_TIMEOUT_MS,
    DOWNLOAD_TOTAL_TIMEOUT_MS,
    downloadImageWithResume,
    resourceRoot,
    defaultGalleryRoot,
    pruneStaleMarkers,
    sanitizeTitle,
    writeGalleryOutputs,
    pruneSiblingPageFiles,
    parsePageRange,
    saveOutcome,

    /* ---- 站点注册表 ---- */
    DEFAULT_SITE_ID,
    registerProvider,
    listSites,
    listChannels,
    getSite,
    siteOfTaskKey,
    resolveStreamSource,
};
