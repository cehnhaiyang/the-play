'use strict';
/**
 * 媒体库：播放列表 = 磁盘目录的镜像。
 *
 * 这一套盯三件事：
 *
 *   1. **编排口径**（`shared/core/library.ts`，纯函数，直接调）：
 *      哪些文件算媒体、画廊目录怎么成组、页码怎么排、点了"刷新"会不会重复。
 *      这些判据以前散在"导入流程"里，导入一删就全没了 —— 现在必须钉住。
 *   2. **接线**：主进程注册 `library-scan` / `library-set-root`，preload 暴露
 *      `library`，桥契约把它们归给应用侧。断一根就是"界面点了没反应"。
 *   3. **旧路径已经消失**：手动导入（file input / 拖拽 / addFiles / filePath /
 *      missing / local-files-check）不能再回来 —— 它和"目录即真值"是两套事实。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...seg) => fs.readFileSync(path.join(ROOT, ...seg), 'utf8');
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

/** 造一条扫盘结果 */
const entry = (relative) => ({
    url: `file:///D%3A/lib/${relative}`,
    relative,
});

const run = () => {
    const fails = [];
    let pass = 0;
    const check = (name, fn) => {
        try { fn(); pass += 1; }
        catch (e) { fails.push({ name, message: e.message }); }
    };

    const lib = require('./build/shared/core/library');

    /* ------------------------------ 编排 ------------------------------ */

    check('只把媒体收进列表：附属文件与半成品全部挡掉', () => {
        const files = lib.buildLibraryFiles([
            entry('video/a.mp4'),
            entry('video/manifest.json'),      // 应用台账
            entry('video/我的画廊.gallery'),     // 成组徽标
            entry('video/x.mp4.part'),          // 半成品
            entry('video/.hidden.mp4'),         // 隐藏文件
            entry('video/notes.torrent'),       // other
            entry('video/绘本.aibook'),          // 容器格式：库里没有打开它的入口
            entry('video/b.m4a'),
        ]);
        const names = files.map((f) => f.name).sort();
        eq(names.join(','), 'a.mp4,b.m4a', `实际收进：${names.join(',')}`);
    });

    check('数字命名的目录整本成组，按页码排', () => {
        const files = lib.buildLibraryFiles([
            entry('manga/10.jpg'), entry('manga/9.jpg'), entry('manga/1.jpg'),
        ]);
        eq(files.length, 3, '三页都要在');
        eq(files.map((f) => f.page).join(','), '1,9,10',
            '页码必须是数值序，逐字符比较会得到 1,10,9');
        for (const f of files) {
            eq(f.groupType, 'gallery', '成组的页要带 groupType=gallery');
            eq(f.groupId, 'lib:manga', 'groupId 必须由目录决定，重启后仍是同一本');
            eq(f.groupName, 'manga', '组名取目录名');
        }
    });

    check('非数字命名的目录只是普通文件夹（不成组）', () => {
        const files = lib.buildLibraryFiles([
            entry('clips/intro.mp4'), entry('clips/outro.mp4'),
        ]);
        for (const f of files) {
            eq(f.groupId, undefined, '普通目录不该被成组');
            eq(f.folder, 'clips', '要带上 folder 供侧栏做目录树');
        }
    });

    check('数字目录里混了非数字文件就不成组', () => {
        const files = lib.buildLibraryFiles([
            entry('mixed/1.jpg'), entry('mixed/2.jpg'), entry('mixed/cover.jpg'),
        ]);
        for (const f of files) {
            eq(f.groupId, undefined, '混排目录成组会让页码与真实文件对不上');
            eq(f.folder, 'mixed', '这种情况按普通文件夹铺开');
        }
    });

    check('单文件目录不成组（一页不叫一本）', () => {
        const files = lib.buildLibraryFiles([entry('single/1.jpg')]);
        eq(files[0].groupId, undefined, '只有一个文件时成组只会多一层空壳节点');
    });

    check('条目地址保留 file://，交给渲染层换成 tpf:', () => {
        const files = lib.buildLibraryFiles([entry('video/a.mp4')]);
        assert(files[0].url.startsWith('file:///'), '库条目必须原样保留磁盘地址');
        eq(files[0].type, 'stream', '库条目是 stream 类型（可被播放列表落盘保留）');
    });

    check('排序按路径自然序，10 在 9 之后', () => {
        const files = lib.buildLibraryFiles([entry('p/10.jpg'), entry('p/9.jpg')]);
        eq(files.map((f) => f.page).join(','), '9,10', '排序口径要与页码一致');
    });

    /* ------------------------------ 接线 ------------------------------ */

    const main = read('app', 'main', 'main.js');
    const librarySrc = read('app', 'main', 'library.js');
    const preload = read('app', 'main', 'preload.js');
    const hook = read('app', 'hooks', 'usePlay.ts');
    const panel = read('app', 'components', 'PlayPanel.tsx');
    const iface = read('shared', 'meta', 'interface.ts');
    const bridge = read('shared', 'meta', 'bridge.ts');
    const settings = read('app', 'main', 'settings.js');

    check('主进程：扫盘与改根两个通道都注册了', () => {
        assert(/ipcMain\.handle\('library-scan'/.test(main), '要注册 library-scan');
        assert(/ipcMain\.handle\('library-set-root'/.test(main), '要注册 library-set-root');
        assert(!/local-files-check/.test(main), '旧的 local-files-check 必须删干净，否则两套真值并存');
    });

    check('主进程扫盘：只做 I/O，判断留给 shared/core', () => {
        assert(/readdirSync/.test(librarySrc), '要走目录');
        assert(/pathToFileURL/.test(librarySrc), '要给渲染层 file:// 地址');
        assert(!/\bgetMediaType\b\s*\(|\bMEDIA_EXTENSIONS\s*[:=]|'mp4'/.test(librarySrc),
            '不许在主进程里再写一份媒体后缀表 —— 它与 shared/core 必然漂移');
        assert(/MAX_ENTRIES/.test(librarySrc), '要有条目上限，库被误指向 C:\\ 时不能拖死渲染层');
        assert(/SKIP_DIRS/.test(librarySrc), 'node_modules / .git 这类目录不能进');
        assert(!/statSync\(full/.test(librarySrc),
            '每个文件再 stat 一次是多余的 syscall：readdir 的 Dirent 已经回答了"是不是文件"');
    });

    check('库根落在设置里，留空即默认项目根 resource', () => {
        assert(/resourceRoot: ''/.test(settings), '默认值必须是空串：绝对路径在打包后不可写');
        assert(/function saveLibraryRoot/.test(settings), '要有保存函数');
        assert(/path\.isAbsolute/.test(settings), '只接受绝对路径（相对路径在主进程里解析到哪由启动方式决定）');
        assert(/module\.exports[\s\S]*saveLibraryRoot/.test(settings), '要导出');
    });

    check('preload 暴露 library.scan / setRoot', () => {
        assert(/library:\s*\{/.test(preload), '要有 library 命名空间');
        assert(/scan:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('library-scan'\)/.test(preload), 'scan 走 library-scan');
        assert(/setRoot:\s*\(value\)\s*=>\s*ipcRenderer\.invoke\('library-set-root', value\)/.test(preload),
            'setRoot 走 library-set-root');
        assert(!/localFiles/.test(preload), '旧的 localFiles 桥必须删掉');
    });

    check('桥契约表把两个端点归给应用侧', () => {
        for (const name of ['library-scan', 'library-set-root']) {
            assert(new RegExp(`'${name}': \\{[\\s\\S]*?route: 'app'`).test(bridge),
                `${name} 必须归 app（fs 只有主进程有）`);
        }
        assert(!/'local-files-check'/.test(bridge), '旧端点要从契约表里删掉');
    });

    check('hook：首屏自动扫库，刷新与改根都在 methods 里', () => {
        assert(/refreshLibrary: \(\) => Promise<LibrarySnapshot>/.test(iface), '接口要有 refreshLibrary');
        assert(/setLibraryRoot: \(value: string\) => Promise<LibrarySnapshot>/.test(iface), '接口要有 setLibraryRoot');
        assert(/libraryRoot: string;/.test(iface), '接口要暴露 libraryRoot');
        assert(/buildLibraryFiles/.test(hook), '条目编排要走 shared/core 的纯函数');
        assert(/api\.library\.scan\(\)/.test(hook), '刷新 = 重新扫盘');
        assert(/api\.library\.setRoot\(value\)/.test(hook), '改根 = 保存并立刻重扫');
        assert(/useEffect\(\(\) => \{\s*void refreshLibrary\(\)/.test(hook), '首屏要自动扫一次，用户不该为此点刷新');
    });

    check('刷新只替换来自磁盘的条目，在线条目留在列表里', () => {
        const i = hook.indexOf('const applyLibrarySnapshot');
        assert(i > 0, '要有 applyLibrarySnapshot');
        const body = hook.slice(i, i + 2200);
        assert(/kept = latest\.files\.filter/.test(body), '要保留非磁盘条目');
        assert(/\^file:\\\/\\\//.test(body), '判据是"地址是不是 file:"，不是"类型是不是 file"');
        assert(/findIndex\(\(f\) => f\.url === currentUrl\)/.test(body),
            '当前播放位置要按 url 锚定，否则刷新会跳回别的条目');
    });

    check('侧栏：导入入口已删除，路径可改、刷新即重扫', () => {
        assert(!/methods\.addFiles/.test(panel), 'addFiles 已不存在（导入功能移除）');
        assert(!/importFilesSmart/.test(panel), '导入流程要整段删掉');
        assert(!/webkitdirectory/.test(panel), '不再有目录选择器');
        assert(!/已失效/.test(panel), '失效标记随"逐条回查"一起删掉：列表本身就来自磁盘');
        assert(/handleApplyRoot/.test(panel), '要有"应用新路径"的入口');
        assert(/setLibraryRoot/.test(panel), '按钮要接到 setLibraryRoot');
        assert(/handleRefreshFiles/.test(panel) && /refreshLibrary/.test(panel), '刷新要接到 refreshLibrary');
        assert(/媒体库目录/.test(panel), '输入框要说明它是什么');
    });

    if (fails.length > 0) {
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  媒体库 ${pass} pass / ${fails.length} fail`);
    return fails.length === 0;
};

module.exports = { run };
