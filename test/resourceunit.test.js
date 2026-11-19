'use strict';
/**
 * 资源单位与分类的回归测试。
 *
 * 钉两件事（都是真实出现过的错误）：
 *  1. 画廊 / AI 绘本是**一个**资源，不是里面的页数 —— 计数不能按页累加；
 *  2. 画廊 / 绘本的页**不算图片资源** —— 它们确实是图片（mediaType 就是 image），
 *     但按 mediaType 分类会让"图片"里塞满整本画廊的上百页。
 *
 * 判据只有一份：shared/core/media 的 isGroupedResource / isAiBookResource。
 * 界面（PlayPanel 的筛选与角标）与这里读的是同一个函数，不再各处手写前缀串。
 */
const path = require('path');

const check = (name, fn, state) => {
    try { fn(); state.pass += 1; }
    catch (e) { state.fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

const run = () => {
    const state = { pass: 0, fails: [] };
    const M = require('./build/shared/core/media.js');

    /* ---- 分组判定 ---- */
    check('画廊页与绘本页都算分组资源', () => {
        assert(M.isGroupedResource({ groupId: 'gallery:dir/名', groupType: 'gallery' }), '画廊目录');
        assert(M.isGroupedResource({ groupId: 'gallery:pack/名' }), '单文件 .gallery 解包');
        assert(M.isGroupedResource({ groupId: 'acg:4262064', groupType: 'gallery' }), 'ACG 抓取');
        assert(M.isGroupedResource({ groupId: 'aibook:x1', groupType: 'ai-book' }), 'AI 绘本');
        void 0;
    }, state);

    check('散图 / 视频 / 文档不是分组资源', () => {
        assert(!M.isGroupedResource({}), '无 groupId');
        assert(!M.isGroupedResource({ groupId: '' }), '空 groupId');
        assert(!M.isGroupedResource(null), 'null 不能抛');
        assert(!M.isGroupedResource(undefined), 'undefined 不能抛');
        // 没有 groupType 也没有约定前缀的 groupId，不能误判成画廊
        assert(!M.isGroupedResource({ groupId: 'playlist:1' }), '无关前缀');
    }, state);

    check('绘本判定与分组判定分开（画廊不算绘本）', () => {
        assert(M.isAiBookResource({ groupType: 'ai-book' }), 'groupType 命中');
        assert(M.isAiBookResource({ groupId: 'aibook:1' }), '前缀命中');
        assert(!M.isAiBookResource({ groupType: 'gallery', groupId: 'gallery:1' }), '画廊不是绘本');
        assert(!M.isAiBookResource(null), 'null 不能抛');
    }, state);

    /* ---- 资源计数（界面角标的口径） ---- */
    /**
     * 复刻 PlayPanel filterCounts 的口径：分组只计一次、分组页不计入图片。
     * 之所以在这里复刻而不是 import 组件：组件依赖 DOM/React，离线跑不了；
     * 而判据本身用的是同一份 isGroupedResource，所以口径不会漂。
     */
    const countUnits = (files) => {
        const counts = {
            all: 0, video: 0, stream: 0, audio: 0,
            image: 0, gallery: 0, book: 0, document: 0,
        };
        const seen = new Set();
        for (const f of files) {
            if (M.isGroupedResource(f)) {
                const gid = f.groupId;
                if (seen.has(gid)) continue;
                seen.add(gid);
                counts.all += 1;
                if (M.isAiBookResource(f)) counts.book += 1;
                else counts.gallery += 1;
                continue;
            }
            counts.all += 1;
            if (f.mediaType === 'image') counts.image += 1;
            else if (f.mediaType === 'video') counts.video += 1;
            else if (f.mediaType === 'gallery') counts.gallery += 1;
        }
        return counts;
    };

    check('100 页画廊 + 1 张散图：画廊计 1、图片计 1、总数 2', () => {
        const pages = Array.from({ length: 100 }, (_, i) => ({
            mediaType: 'image', groupId: 'gallery:dir/本', groupType: 'gallery', page: i + 1,
        }));
        const files = [...pages, { mediaType: 'image', name: '散图.jpg' }];
        const c = countUnits(files);
        eq(c.gallery, 1, '一本画廊就是一个画廊资源');
        eq(c.image, 1, '画廊的页不能计入图片');
        eq(c.all, 2, '资源单位总数 = 1 本画廊 + 1 张散图');
    }, state);

    check('两本绘本各若干页：绘本计 2、图片计 0', () => {
        const files = [
            { mediaType: 'image', groupId: 'aibook:a', groupType: 'ai-book' },
            { mediaType: 'image', groupId: 'aibook:a', groupType: 'ai-book' },
            { mediaType: 'image', groupId: 'aibook:b', groupType: 'ai-book' },
        ];
        const c = countUnits(files);
        eq(c.book, 2, '两本绘本');
        eq(c.image, 0, '绘本页不是图片资源');
        eq(c.all, 2, '总数按本算');
    }, state);

    check('没有分组的纯图片仍然正常计入图片', () => {
        const files = [
            { mediaType: 'image', name: 'a.jpg' },
            { mediaType: 'image', name: 'b.png' },
            { mediaType: 'video', name: 'c.mp4' },
        ];
        const c = countUnits(files);
        eq(c.image, 2, '散图照常计数');
        eq(c.video, 1);
        eq(c.all, 3);
    }, state);

    /* ---- 界面口径必须与判据同源 ---- */
    check('PlayPanel 的筛选与计数走共享判据，不再手写 groupId 前缀', () => {
        const src = require('fs').readFileSync(
            path.join(__dirname, '..', 'app', 'components', 'PlayPanel.tsx'), 'utf8');
        assert(/isGroupedResource/.test(src), 'PlayPanel 必须使用 isGroupedResource');
        assert(/isAiBookResource/.test(src), 'PlayPanel 必须使用 isAiBookResource');
        // 图片筛选必须排除分组页，否则"图片"里又是整本画廊
        assert(/playlistFilter === 'image'\)[\s\S]{0,120}!isGroupedFile/.test(src),
            '图片筛选必须排除画廊/绘本的分组页');
        assert(!/groupType === 'gallery'\s*\n?\s*\|\| file\.groupId\.startsWith\('acg:'\)/.test(src),
            '分组判据不该在组件里再写一份');
    }, state);

    if (state.fails.length > 0) {
        for (const f of state.fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  资源单位与分类 ${state.pass} pass / ${state.fails.length} fail`);
    return state.fails.length === 0;
};

module.exports = { run };
