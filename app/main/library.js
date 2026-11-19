const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const settings = require('./settings');
const gallery = require('./gallery');

/**
 * 媒体库：把磁盘目录扫成一份文件清单。
 *
 * ## 为什么播放列表是"目录的镜像"
 *
 * 之前靠手动导入（文件/文件夹选择器）：拿到的是 `File` 句柄，重启即失效，
 * 落盘也无从恢复。而所有下载产物本来就在 `resource/` 下按站点与作品分好了目录 ——
 * 再让用户"导入"一次既是重复劳动，也多出一条与磁盘不同步的第二真值。
 * 现在只有一条来源：目录。刷新 = 重新扫一遍。
 *
 * ## 只做 I/O，不做判断
 *
 * "什么算媒体""目录怎么成组"全部在 `shared/core/library.ts`（纯函数，Node 可测）。
 * 这里只走目录、拼 `file://`。媒体判定一旦搬进来，主进程（CJS，import 不了 TS）
 * 就得抄一份后缀表，两份必然漂移。
 */

/** 单次扫描的条目上限。库被误指向 C:\\ 时不能把渲染层和内存一起拖死 */
const MAX_ENTRIES = 20000;
/** 目录深度上限：正常情况下 resource/<site>/<作品>/<页> 最多三层 */
const MAX_DEPTH = 12;

/** 不进入的目录名：版本库与依赖目录里没有媒体，却可能有几十万个文件 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$RECYCLE.BIN', 'System Volume Information']);

/** 默认库根：与下载根共用同一个口径（见 gallery.resourceRoot） */
function defaultRoot() {
    return gallery.resourceRoot();
}

/** 当前生效的库根：设置里填了就用它，留空用默认值 */
function currentRoot() {
    const saved = String((settings.getSettings().resourceRoot || '')).trim();
    return saved || defaultRoot();
}

/**
 * 递归收集文件。
 *
 * 这里**只判断"要不要进这一层目录"**（性能与结构），文件级过滤交给
 * shared/core/library.ts —— 两边各筛一遍名字，新增一种要忽略的东西必然漏一处。
 *
 * 用递归而不是队列：深度有上限，且目录嵌套本身就是深度优先的自然顺序，
 * 后续排序由渲染层按相对路径做，这里不必保证顺序。
 */
function walk(dir, rootDir, out) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
        // 权限不足 / 目录被删：跳过这一层，不因为一个子目录让整次扫描失败
        return;
    }
    for (const entry of entries) {
        if (out.length >= MAX_ENTRIES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            // 点开头的目录一律不进：.git 之外还有编辑器缓存、快照目录等，
            // 它们只会有海量小文件
            if (entry.name.startsWith('.')) continue;
            if (full.split(path.sep).length - rootDir.split(path.sep).length > MAX_DEPTH) continue;
            walk(full, rootDir, out);
            continue;
        }
        // readdir 的 Dirent 已经回答了"是不是普通文件"，不必再 stat 一次：
        // 593 个文件就是 593 次多余的 syscall。扫描期间被删掉的文件会在播放时
        // 由协议处理器回 404，界面上表现为一条报错的条目 —— 与"扫不到"等价。
        if (!entry.isFile()) continue;
        out.push({
            url: pathToFileURL(full).href,
            relative: path.relative(rootDir, full).split(path.sep).join('/'),
        });
    }
}

/**
 * 扫一次库。返回 { root, exists, entries, truncated }。
 *
 * 目录不存在时 exists=false 且条目为空 —— 这是**正常结果**而不是错误：
 * 用户把路径改到一个还没建的空目录时，界面该说"目录为空"，而不是弹一个错误。
 */
function scan(root) {
    const target = String(root || currentRoot());
    // throwIfNoEntry: false —— 目录不存在是正常结果（用户可能指向还没建的目录），
    // 不是异常；这里刻意不套 try，缺目录不该走异常流
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    const exists = Boolean(stat && stat.isDirectory());
    const entries = [];
    if (exists) walk(target, target, entries);
    return {
        root: target,
        exists,
        entries,
        truncated: entries.length >= MAX_ENTRIES,
    };
}

/** 扫当前生效的库根 */
function scanCurrent() {
    return scan(currentRoot());
}

/**
 * 改库根并立即返回新路径的扫描结果。
 *
 * 校验与扫描放在一次调用里：只保存不扫的话，界面得再发一次请求，
 * 而两次之间用户可能已经改了输入框里的值 —— 会扫到另一条路径上去。
 * 保存失败时照样回一份**当前**库根的扫描结果：界面据此把列表留在原状，
 * 而不是让调用方拿一个空清单去覆盖。
 */
function setRoot(input) {
    const saved = settings.saveLibraryRoot(input);
    if (!saved.success) {
        return { success: false, message: saved.message, ...scanCurrent() };
    }
    return { success: true, message: saved.message, ...scan(saved.resourceRoot || defaultRoot()) };
}

module.exports = {
    scanCurrent,
    setRoot,
};
