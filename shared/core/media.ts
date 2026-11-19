/**
 * 媒体类型判定：一个地址/文件名到底是"什么东西"。
 *
 * ## 这一层为什么必须与 DOM 无关
 *
 * 判定逻辑同时被三处使用，而这三处的运行环境完全不同：
 *   · Electron 渲染层（有 DOM）
 *   · 插件 service worker（**没有 DOM**）
 *   · Node 回归测试（没有 DOM）
 *
 * 所以本文件不得出现 `window` / `document` / `localStorage`，也不得 import
 * 任何带副作用的包。一旦破例，插件侧的表现是"service worker 启动即崩"，
 * 而 TypeScript 不会拦（它只看类型，不看运行环境）。
 *
 * ## 后缀表是唯一真值，其余全部派生
 *
 * `MEDIA_EXTENSIONS` 是这张表的唯一定义处。派生方：`getMediaType` 的查表、
 * 插件嗅探的后缀清单（`extension/src/shared/classify.ts`）、画廊页码识别、
 * 主进程的 `STREAM_EXTENSIONS`（独立进程不能 import TS，是派生副本，
 * 由 test/mainstatic.test.js 盯着不漂移 —— 它决定下载走 ffmpeg 还是裸 HTTP）。
 *
 * 曾经这几处各写一份，结果 `.avif` 只补了一处、漏了另一处 —— 页内嗅探扫到它
 * 归为 other 后直接丢弃，同一个文件走两条路径结论不同。新增后缀只改这里，
 * 但**每一个派生方都要跟着**（漏一处就是这个后果，而两边各自都"成功"）。
 */
import type { MediaType } from '../meta';

/**
 * 后缀 → 媒体类型。
 *
 * 末尾那组关键字兜底（见 `getMediaType`）是刻意更松的独立判据，不在此列。
 */
export const MEDIA_EXTENSIONS: Record<string, MediaType> = {
    // Stream
    'm3u8': 'stream',
    'm3u': 'stream',
    'mpd': 'stream',
    'ts': 'stream',
    'flv': 'stream', // 注意：标准 H5 Video 不支持 FLV，通常需要 flv.js，这里先归类为流
    'f4v': 'stream',

    // Video
    'mp4': 'video',
    'mkv': 'video',
    'webm': 'video',
    'avi': 'video',
    'mov': 'video',
    'wmv': 'video',
    'ogv': 'video',
    '3gp': 'video',
    'mpg': 'video',
    'mpeg': 'video',
    'm4s': 'video',

    // Audio
    'mp3': 'audio',
    'wav': 'audio',
    'aac': 'audio',
    'm4a': 'audio',
    'ogg': 'audio',
    'flac': 'audio',
    'opus': 'audio',
    'wma': 'audio',

    // Image
    'jpg': 'image',
    'jpeg': 'image',
    'png': 'image',
    'gif': 'image',
    'webp': 'image',
    'svg': 'image',
    'bmp': 'image',
    'ico': 'image',
    'tiff': 'image',
    'heic': 'image',
    'avif': 'image',

    // Document / Markdown / Text
    'md': 'document',
    'markdown': 'document',
    'txt': 'document',
    'log': 'document',
    'pdf': 'document',
    'json': 'document',

    // Custom AI Book（AI 绘本归档：JSON，内含分页图片 + 文案）
    // 导入时由 PlayPanel 的 importFilesSmart 识别并解包成组；
    // 这里的 image 分类只用于「没被识别成绘本」时的兜底展示。
    'aibook': 'image',

    // Gallery（画廊徽标文件，代表一本多页图集的文件夹）
    'gallery': 'gallery',
};

/**
 * HLS 分片路径判据的**正则源码**（不是正则对象）。
 *
 * 导出字符串而不是正则对象：页内嗅探脚本整体是一个模板字符串、注入浏览器执行，
 * 它没法 import 一个正则对象，只能把源码插值进去自己 new RegExp。
 * 两处共用这一份语义：页内脚本（插值源码）与文本兜底提取（isHlsSegmentPath）。
 *
 * 用途：判断一个 **.ts** 地址是 HLS 分片（丢弃）还是整段视频（保留）。
 * 判据只在 ext === 'ts' 时被调用，所以每条分支都锚在 .ts 上 ——
 * 不写成通用"像不像分片"，那样会把 `seg.mp4` 这种正常文件也判进来。
 *
 * 四条判据，都是实测见过的分片命名：
 *  1. 目录段是分片词（`/ts/000.ts`、`/seg/1.ts`、`/seg-1/x.ts`）——
 *     分片常被集中放在固定目录下；
 *  2. 文件名以分片词开头（`seg1.ts`、`chunk_00001.ts`、`part.ts`）——
 *     `\d*` 不能省：`seg1.ts` 里 `g` 与 `1` 都是词字符，`\bseg\b` 整条漏掉；
 *  3. 文件名整个是数字（`000.ts`、`1.ts`）；
 *  4. `[-_]\d+.ts`，兜住 `xxx-1.ts`。
 *
 * 数字判据**锚在文件名上**，不是"路径里出现两位数字"：
 * 后者会把 `/video/2024/lecture.ts` 这种带年份目录的整段视频当成分片丢掉
 * —— 而整段 .ts 同样可下载，正是这份判据要保护的东西。
 */
export const HLS_SEGMENT_RE_SOURCE =
    '(?:^|/)(?:segment|seg|chunk|slice|frag|part|track|ts)[-_]?\\d*/'
    + '|(?:^|/)(?:segment|seg|chunk|slice|frag|part|track)[-_]?\\d*\\.ts$'
    + '|(?:^|/)\\d+\\.ts$'
    + '|[-_]\\d+\\.ts$';

/** 判断一个 URL 的路径是不是 HLS 分片（只对 .ts 有意义，大小写不敏感） */
export const isHlsSegmentPath = (pathname: string): boolean =>
    !!pathname && new RegExp(HLS_SEGMENT_RE_SOURCE, 'i').test(pathname);

/**
 * 这条资源是否**必须交给 ffmpeg** 才能得到可用文件。
 *
 * 判据取或，两个都要看：
 *  - `type === 'stream'`：渲染层已经把它归类为流；
 *  - 后缀属 stream 类：`type` 与 `ext` 来自不同的判据（分类看 content-type，
 *    条目构造看 URL 后缀），两者不必自洽，也可能只给得出一个 ——
 *    只按 type 判会让一个 .flv 条目走裸 HTTP 下载。
 *
 * **三处必须同源**，否则界面与实际行为对不上：
 *  - 主进程 handleMediaDownload 的 isStream（决定走 ffmpeg 还是裸 HTTP）；
 *  - 嗅探面板的「下载」按钮禁用条件（ffmpeg 缺失时该不该拦）；
 *  - 下载提示文案。
 * 判据不一致的后果实测过：界面按 type 判、主进程按 ext 判，
 * 于是一个 .flv 条目在 ffmpeg 缺失时按钮照常可点，点下去才报"未找到 ffmpeg"。
 */
export const requiresFfmpeg = (type: string | undefined, ext: string | undefined): boolean =>
    type === 'stream' || MEDIA_EXTENSIONS[(ext || '').toLowerCase()] === 'stream';

/** 剥掉 query 与 hash 只留路径；非 URL（含 blob:）回落成字符串切分 */
const cleanUrlPath = (urlFull: string): string => {
    if (urlFull.startsWith('blob:')) return '';
    try {
        return new URL(urlFull).pathname;
    } catch {
        return urlFull.split('?')[0].split('#')[0];
    }
};

/** 从名字或地址里取小写后缀（无后缀返回 ''） */
const extFromStr = (str?: string): string => {
    if (!str) return '';
    const match = cleanUrlPath(str).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
};

/**
 * 媒体类型推断。优先级：MIME > 后缀查表 > 关键字兜底 > other。
 *
 * 兜底那组关键字刻意比查表更松（子串匹配），用来接住"后缀被 query 藏起来"
 * 的地址；未知文件**严禁**归为视频，一律落 other。
 */
export const getMediaType = (name: string, mimeType?: string, url?: string): MediaType => {
    if (mimeType) {
        if (mimeType === 'application/x-mpegurl'
            || mimeType === 'application/vnd.apple.mpegurl'
            || mimeType === 'application/dash+xml') {
            return 'stream';
        }
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('text/')
            || mimeType === 'text/markdown'
            || mimeType === 'application/pdf'
            || mimeType === 'application/json') {
            return 'document';
        }
    }

    // 名字里的后缀优先；它不认识时（或压根没有）才回落到地址
    let ext = extFromStr(name);
    if (!MEDIA_EXTENSIONS[ext]) {
        const urlExt = extFromStr(url);
        if (MEDIA_EXTENSIONS[urlExt]) ext = urlExt;
    }
    if (MEDIA_EXTENSIONS[ext]) return MEDIA_EXTENSIONS[ext];

    const lowerBoth = `${name || ''} ${url || ''}`.toLowerCase();
    if (lowerBoth.includes('.m3u8') || lowerBoth.includes('.mpd')) return 'stream';
    if (['.webp', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.avif'].some((s) => lowerBoth.includes(s))) return 'image';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.opus'].some((s) => lowerBoth.includes(s))) return 'audio';
    if (['.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv'].some((s) => lowerBoth.includes(s))) return 'video';
    if (['.md', '.markdown', '.txt', '.log', '.pdf', '.json'].some((s) => lowerBoth.includes(s))) return 'document';

    return 'other';
};

/* -------------------------------------------------------------------------- */
/*                      本地文件的可播放地址（file:// 不能用）                   */
/* -------------------------------------------------------------------------- */
/**
 * 应用自有的本地文件协议。必须与主进程 `registerLocalFileProtocol` 里注册的一致。
 *
 * ## 为什么不能直接用 file://
 *
 * 渲染层有两种来源：开发态是 `http://localhost:5173`（`.bat` 走的就是这条），
 * 打包态是 `file://`。从**非 file 来源**加载 `file://` 媒体会被 Blink 拦下，
 * 实测（Electron 44.4.5，dev 源）事件序列是
 *
 *     emptied → play → waiting → loadstart → error
 *     error.code = 4, message = "Media load rejected by URL safety check"
 *     networkState = 3 (NO_SOURCE)，currentTime 永远 0
 *
 * 而"保存到本地"这条链路（acgmhoService / ehentaiService 的 pathToFileURL）
 * 恰好把播放列表里的地址改写成 `file://`，并随播放列表落盘 —— 于是**每次重启**
 * 恢复出来的本地条目全都落在上面那条死路上：界面一直转圈，因为元素拿不到任何数据。
 *
 * 所以本地文件统一改走主进程的 `tpf:` 协议（带 Range，可拖动），
 * 渲染层只认这一个入口，不再出现"dev 能播 / 打包不能播"这种按来源分叉的行为。
 *
 * 纯字符串映射，不碰 DOM —— 插件与 Node 测试都能安全求值。
 */
export const LOCAL_FILE_SCHEME = 'tpf:';

/**
 * 把本地文件地址换成渲染层真正能播的地址。
 *
 * `file:///D:/a/b%20c.mp4` → `tpf://local/D%3A%2F%2Fa%2Fb%20c.mp4`
 *
 * 整段路径做一次 encodeURIComponent：分隔符与冒号都被编码，主进程只需
 * decode 一次就得到原始绝对路径，不存在"哪部分是路径、哪部分是查询串"的歧义。
 * 非 file:// 地址（https / blob / data）原样返回。
 */
export const toPlayableUrl = (url: string): string => {
    const raw = (url || '').trim();
    if (!/^file:\/\//i.test(raw)) return url;
    // 去掉 scheme 与开头的斜杠，剩下的可能是 D:/a/b 或 /home/a/b（POSIX）
    let rest = raw.replace(/^file:\/\//i, '');
    // file://host/share 形式：主机段通常为空，非空时并回路径
    try {
        rest = decodeURIComponent(rest);
    } catch {
        // 非法百分号编码：按字面量处理，别让一条坏地址把整次播放打断
    }
    rest = rest.replace(/^\/+/, '');
    // Windows 盘符前的多余斜杠已在上面处理；POSIX 绝对路径需要补回根
    const absolute = /^[A-Za-z]:[\\/]/.test(rest) ? rest : `/${rest}`;
    return `${LOCAL_FILE_SCHEME}//local/${encodeURIComponent(absolute.replace(/\\/g, '/'))}`;
};

/** 播放器可接受的 URL 白名单校验：仅 http(s) / blob，拒绝 javascript:/data:/file: 等 */
export const isValidMediaUrl = (url: string): boolean => {
    const trimmed = (url || '').trim();
    if (!trimmed || trimmed.length > 8192) return false;
    if (/^(javascript|data|file|vbscript):/i.test(trimmed)) return false;
    return /^(https?:\/\/|blob:)/i.test(trimmed);
};

/* -------------------------------------------------------------------------- */
/*                        资源单位：分组媒体是一整本                             */
/* -------------------------------------------------------------------------- */
/**
 * 画廊 / AI 绘本这类**多页资源**：它们由很多页组成，但对外是**一个**资源。
 *
 * 判据是「有没有分组身份」，不是「每页是什么类型」—— 画廊页、绘本页的
 * mediaType 本来就是 image（它们确实是图片），若按 mediaType 分类，一本 100 页的
 * 画廊会在"图片"分类里变成 100 个资源，角标与列表也随之对不上。
 *
 * 所以凡是要**按资源计数或按类型筛选**的地方，都必须先问这里：
 * 分组页归它所属的那一本（画廊/绘本），不单独计入图片。
 */
export interface GroupedResourceLike {
    groupId?: string;
    groupType?: string;
}

/** 该条目是否属于某个分组资源（画廊 / 绘本）的一页 */
export const isGroupedResource = (item: GroupedResourceLike | null | undefined): boolean => {
    if (!item) return false;
    const gid = item.groupId || '';
    const type = item.groupType || '';
    return type === 'gallery' || type === 'ai-book'
        // 历史数据没有 groupType，只有约定前缀的 groupId
        || gid.startsWith('acg:') || gid.startsWith('gallery:') || gid.startsWith('aibook:');
};

/** 是否为 AI 绘本（决定图标、文案与阅读器版式） */
export const isAiBookResource = (item: GroupedResourceLike | null | undefined): boolean => {
    if (!item) return false;
    return item.groupType === 'ai-book' || (item.groupId || '').startsWith('aibook:');
};
