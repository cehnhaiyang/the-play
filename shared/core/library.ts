/**
 * 媒体库：把「磁盘上的一批文件」映射成播放列表条目。
 *
 * ## 为什么这段逻辑必须与 DOM / fs 都无关
 *
 * 播放列表的来源是库目录（默认项目根的 `resource`），拆成两层之后：
 *
 *   · 主进程（`app/main/library.js`）只负责走目录，产出 `{ url, relative }`；
 *   · 本文件只负责**判断与编排**：哪些文件算媒体、目录怎么成组、页码怎么排。
 *
 * 这样"什么算一个资源"只有这一处口径。这一点很关键：主进程是纯 CJS、import
 * 不了 TS，媒体后缀表一旦抄过去就是两份，而两边各自都"成功"，直到某个后缀只补
 * 了一边才会暴露。Node 回归测试也能直接调本文件（主进程那份走 fs，测不了）。
 *
 * ## 目录即资源
 *
 * `resource/<site>/<前缀>-<gid>/1.jpg … N.jpg` 是画廊的落盘形态，一整个目录就是
 * **一本**画廊。所以：目录里的媒体文件名词干全是数字、且至少两个 → 整目录成组
 * （groupType='gallery'，按页码排序，侧栏显示为一个节点 + 1/N）。
 * 其余目录只是普通文件夹（`folder`），侧栏按目录树嵌套。
 */
import type { LibraryFileEntry, VideoFile } from '../meta';
import { createStreamFile } from './files';
import { getMediaType } from './media';

/**
 * 排序比较器：按路径自然序（数字段按数值比）。
 *
 * 必须用 numeric 比较：`10.jpg` 排在 `9.jpg` 之后才是人看着的顺序，
 * 逐字符比较会得到 1, 10, 11, 2 —— 画廊页序会整体错乱。
 */
const comparePath = (a: string, b: string): number =>
    a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });

/** 相对路径的目录部分；根目录下的文件返回 '' */
const dirOf = (relative: string): string => {
    const i = relative.lastIndexOf('/');
    return i < 0 ? '' : relative.slice(0, i);
};

/** 文件名（去掉目录） */
const baseOf = (relative: string): string => {
    const i = relative.lastIndexOf('/');
    return i < 0 ? relative : relative.slice(i + 1);
};

/** 文件名去掉最后一个后缀：`12.jpg` → `12` */
const stemOf = (name: string): string => {
    const i = name.lastIndexOf('.');
    return i <= 0 ? name : name.slice(0, i);
};

/**
 * 该文件是否不该进库。
 *
 * 判据只有这一处：主进程只负责走目录，不再重复筛一遍名字 ——
 * 两边各筛一次时，新增一种要忽略的东西必然漏掉一边。
 *
 * 挡的都不是"内容不好"，而是结构性的噪音：点开头的隐藏文件、下载中的半成品
 * （体积为 0 或写了一半，列出来就是一条点开必然失败的条目），以及应用自己写的
 * 台账 —— `manifest.json` 记这本画廊是怎么来的、`<标题>.gallery` 是成组徽标、
 * `.aibook` 是打包过的绘本容器（库里没有从路径解包它的入口，列出来点不动）。
 */
const isIgnoredLibraryName = (name: string): boolean => {
    if (!name || name.startsWith('.')) return true;
    if (/\.(part|tmp|download|crdownload|!ut)$/i.test(name)) return true;
    if (name.toLowerCase() === 'manifest.json') return true;
    if (/\.gallery$/i.test(name)) return true;
    return /\.aibook$/i.test(name);
};

/**
 * 把扫盘结果编排成播放列表条目。
 *
 * 过滤掉 `mediaType === 'other'`（.torrent / .json 这类库里的附属文件）——
 * 它们不是媒体，进了列表只会是一条点了没反应的条目。
 */
export const buildLibraryFiles = (entries: LibraryFileEntry[]): VideoFile[] => {
    const media = (entries || [])
        .filter((e) => e && e.relative && e.url && !isIgnoredLibraryName(baseOf(e.relative)))
        .map((e) => {
            const name = baseOf(e.relative);
            return { entry: e, name, mediaType: getMediaType(name, undefined, e.url) };
        })
        .filter((x) => x.mediaType !== 'other')
        .sort((a, b) => comparePath(a.entry.relative, b.entry.relative));

    // 目录 → 该目录下的媒体文件；一次遍历建好，供下面判"是否整目录成组"
    const byDir = new Map<string, typeof media>();
    for (const item of media) {
        const dir = dirOf(item.entry.relative);
        const list = byDir.get(dir);
        if (list) list.push(item);
        else byDir.set(dir, [item]);
    }

    /**
     * 整目录成组的判据：目录非空、至少两个媒体文件、且**每个**文件名的词干都是数字。
     *
     * 只要有一个文件不是数字命名，就不是画廊落盘形态（可能是个普通文件夹里
     * 混了几张截图），此时按普通文件夹处理 —— 硬成组会让页码与真实文件对不上。
     */
    const galleryDirs = new Set<string>();
    for (const [dir, list] of byDir) {
        if (!dir || list.length < 2) continue;
        if (list.every((x) => /^\d+$/.test(stemOf(x.name)))) galleryDirs.add(dir);
    }

    return media.map(({ entry, name, mediaType }) => {
        const dir = dirOf(entry.relative);
        const file = createStreamFile(entry.url, name, mediaType);
        if (galleryDirs.has(dir)) {
            // groupId 用相对路径：同一个目录永远同一个组，重启/刷新后不会变成两本
            file.groupId = `lib:${dir}`;
            file.groupName = dir.slice(dir.lastIndexOf('/') + 1);
            file.groupType = 'gallery';
            file.page = Number(stemOf(name));
        } else if (dir) {
            file.folder = dir;
        }
        return file;
    });
};
