const fs = require('fs');
const path = require('path');
const { protocol } = require('electron');
const { Readable } = require('stream');

/**
 * 本地文件协议 `tpf:`：把磁盘文件按 HTTP 语义喂给渲染层。
 *
 * ## 为什么渲染层不能直接用 file://
 *
 * 开发态页面来源是 `http://localhost:5173`（`.bat` 走的就是这条）。从**非 file
 * 来源**加载 `file://` 媒体会被 Blink 拦下，实测（Electron 44.4.5）事件序列是
 *
 *     emptied → play → waiting → loadstart → error
 *     error.code = 4，message「Media load rejected by URL safety check」
 *     networkState = 3（NO_SOURCE），currentTime 永远 0
 *
 * 表现就是播放器无限转圈，而文件本身、编解码、缓存全都没问题。
 *
 * 于是由主进程自己供流：能读到文件就能播，与页面来源无关。
 *
 * ## 为什么必须实现 Range
 *
 * 媒体元素不是"从头顺序读一个文件"：定位（seek）靠的是向服务器要某一段字节，
 * 拿到 206 + `Content-Range` 才能把时间轴映射到文件偏移。只回 200 全文，
 * 元素就只能整段重新下 —— 拖一下进度条要等好几秒，正是这个原因。
 */

/** 协议名。渲染层那份在 shared/core/media.ts 的 LOCAL_FILE_SCHEME（带冒号） */
const LOCAL_FILE_SCHEME = 'tpf';

/**
 * 必须在 app ready **之前**调用。
 *
 * standard：让 URL 有正常的 host/path 语义（否则 pathname 拿不到完整路径）；
 * stream：媒体元素可以边读边播，而不是等整个响应体就绪；
 * supportFetchAPI / bypassCSP：让 fetch 与 CSP 都按常规处理这个源。
 */
function registerLocalFileScheme() {
    protocol.registerSchemesAsPrivileged([{
        scheme: LOCAL_FILE_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
    }]);
}

/** 按后缀给 Content-Type：媒体元素靠它决定用哪个解码器 */
function contentTypeOf(filePath) {
    const table = {
        '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
        '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
        '.pdf': 'application/pdf',
    };
    return table[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * 解析一条 Range 头，返回闭区间 [start, end] 或 null（语法不认识）。
 *
 * 只支持单段 `bytes=a-b`（媒体元素的常规用法）。多段请求回到 416 让上层重发：
 * 猜一个"第一段"去应付，比明确拒绝更难排查。
 */
function parseRange(header, total) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    let start;
    let end;
    if (m[1] === '') {
        // 后缀式 `bytes=-N`：最后 N 字节
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return null;
    return { start, end };
}

/**
 * 在 app ready 之后调用，把 `tpf://local/<encodeURIComponent(绝对路径)>` 接到文件流。
 *
 * 不存在的文件回 404（而不是空 200）：渲染层才会收到 error 事件，
 * 而不是对着一个永远没有数据的响应等到超时。
 */
function registerLocalFileProtocol() {
    protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
        let filePath = '';
        try {
            const parsed = new URL(request.url);
            filePath = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
        } catch (_e) {
            filePath = '';
        }
        if (!filePath) return new Response('bad request', { status: 400 });

        const stat = fs.statSync(filePath, { throwIfNoEntry: false });
        if (!stat || !stat.isFile()) return new Response('not found', { status: 404 });

        const total = stat.size;
        const headers = {
            'Content-Type': contentTypeOf(filePath),
            'Accept-Ranges': 'bytes',
        };
        const rangeHeader = request.headers.get('range') || request.headers.get('Range');
        if (!rangeHeader) {
            return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
                status: 200,
                headers: { ...headers, 'Content-Length': String(total) },
            });
        }

        const range = parseRange(rangeHeader, total);
        if (!range) {
            // 416 必须带 Content-Range: bytes */total —— 元素据此知道真实长度，
            // 否则它会以为"这个源没有尽头"，进度条与定位一起失效
            return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
        }
        return new Response(Readable.toWeb(fs.createReadStream(filePath, { start: range.start, end: range.end })), {
            status: 206,
            headers: {
                ...headers,
                'Content-Length': String(range.end - range.start + 1),
                'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
            },
        });
    });
}

module.exports = {
    LOCAL_FILE_SCHEME,
    registerLocalFileScheme,
    registerLocalFileProtocol,
};
