'use strict';
/**
 * 播放列表侧栏：大批量条目下的渲染性能 + 「刷新」本地文件状态。
 *
 * 两个真实痛点：
 *   1. 侧栏此前每次重渲染都重画整棵树。PlayPanel 每帧都在动（timeupdate 每秒
 *      改好几次 currentTime），几千条就是几万个 DOM 节点反复重建；渲染期还在
 *      为每个文件夹节点递归收集叶子下标，而那个结果只随列表变化。
 *   2. 列表拿的是导入那一刻的 `File` 句柄，文件被删或搬走后句柄不报错 ——
 *      列表看着正常、点下去才知道放不出来，所以要能主动问磁盘一次。
 *
 * 只做结构与契约断言：真实渲染要在应用里看，但"接线断了"能在这里拦住。
 */
const fs = require('fs');
const path = require('path');

const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};
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

    const panel = read('app', 'components', 'PlayPanel.tsx');
    const hook = read('app', 'hooks', 'usePlay.ts');
    const preload = read('app', 'main', 'preload.js');
    const iface = read('shared', 'meta', 'interface.ts');
    const css = read('app', 'index.css');

    /* ------------------------------ 性能 ------------------------------ */

    check('列表渲染搬到 memo 过的独立组件里', () => {
        // 只断言"被 memo 包住"这个不变量，不锁具体写法（React.memo + 具名函数、
        // 或 FC 泛型包装都算合格）
        assert(/const PlaylistTree\s*=\s*React\.memo\(/.test(panel),
            'PlaylistTree 必须用 React.memo 包住：否则播放进度一跳动就重画整棵树');
        assert(/rows=\{playlistRows\}/.test(panel), 'PlayPanel 要把扁平行表交给它，而不是自己 map');
        assert(!/playlistTree\.map\(/.test(panel),
            'PlayPanel 不该再直接 map 整棵树（那样每次重渲染都重建全部行）');
    });

    check('只画可视窗口那几十行', () => {
        assert(/const TREE_ROW_HEIGHT = \d+/.test(panel), '要有固定行高常量（虚拟滚动按它换算下标）');
        assert(/rows\.slice\(start, end\)/.test(panel), '只渲染窗口切片');
        assert(/height: rows\.length \* TREE_ROW_HEIGHT/.test(panel), '外层要撑出真实滚动高度');
        assert(/translateY\(\$\{start \* TREE_ROW_HEIGHT\}px\)/.test(panel), '内层按窗口起点整体上移');
        assert(/new ResizeObserver/.test(panel), '视口高度要跟着容器走');
        assert(/useLayoutEffect/.test(panel), '测量要在 paint 前完成，否则首帧少画几行');
    });

    check('行也 memo：只有状态变了的那一行重画', () => {
        assert(/const PlaylistFileRow\s*=\s*React\.memo\(/.test(panel), '文件行要 memo');
        assert(/const PlaylistNodeRow\s*=\s*React\.memo\(/.test(panel), '分组/文件夹行要 memo');
        // 行高必须由常量写死，不能靠 py-2 撑出高度（否则窗口换算会漂）
        assert(/height: TREE_ROW_HEIGHT/.test(panel), '行高要用常量，不然滚动位置会漂');
    });

    check('叶子下标在构建树时算完', () => {
        assert(/const finalize = \(nodes: TreeNode\[\]\)/.test(panel),
            '要有自底向上的 finalize 一趟算完');
        assert(!/const collectLeafIndexes/.test(panel),
            '渲染期不该再递归收集叶子（那是每帧 O(项数×文件夹数)）');
        assert(/leaves: number\[\]/.test(panel), '节点上要带预计算的 leaves');
    });

    /* ------------------------------ 刷新 ------------------------------ */
    // 「刷新」的语义已经从"逐条回查文件还在不在"改成"重新扫库目录"，
    // 那部分接线由 test/library.test.js 负责，这里只留一条反向断言：
    // 旧的逐条回查不许回来 —— 它与"目录即真值"是两套事实。

    check('旧的本地文件回查已删除', () => {
        assert(!/localFiles/.test(hook), 'hook 里不该再有 localFiles 桥');
        assert(!/refreshLocalFiles/.test(hook), 'refreshLocalFiles 已被 refreshLibrary 取代');
        assert(!/localFiles/.test(iface), '接口里不该再有 ElectronLocalFilesAPI');
        assert(!/webUtils/.test(preload), '路径解析随导入一起删除，preload 不再需要 webUtils');
    });

    /* ------------------------------ 删除入口 ------------------------------ */
    // 列表是目录的镜像：这一秒删掉一条，下一次重扫它就回来了。
    // 所以侧栏的删除入口（顶部清空 / 行内移除 / 整组移除）连同底层三个方法一起删除，
    // 这条反向断言防止它们被"顺手"加回来。

    check('侧栏不再有删除入口', () => {
        assert(!/removeTrack|removeTracks|clearPlaylist/.test(panel),
            'PlayPanel 不该再引用移除/清空方法');
        assert(!/removeTrack|removeTracks|clearPlaylist/.test(hook),
            'usePlay 不该再有移除/清空逻辑：删了也会被重扫原样带回来');
        assert(!/removeTrack|removeTracks|clearPlaylist/.test(iface),
            '接口里不该再暴露这三个方法');
        assert(!/tp-row-action/.test(css),
            '.tp-row-action 只服务于行内删除键，随按钮一起删除');
    });

    if (fails.length > 0) {
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  侧栏性能与刷新 ${pass} pass / ${fails.length} fail`);
    return fails.length === 0;
};

module.exports = { run };
