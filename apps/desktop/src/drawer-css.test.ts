import { describe, expect, it } from 'vitest';

/**
 * 守卫：`.app-sidebar` **只在抽屉里出现**，所以针对它的规则必须是
 * 「浮层的规则」，不能是「常驻侧栏的规则」。
 *
 * ## 被它守着的那个 bug
 *
 * `styles.css` 里曾经有一块：
 *
 *     @container shell (max-width: 900px) {
 *       .app-sidebar .nav-label,
 *       .app-sidebar .nav-brand-text, … { display: none; }
 *     }
 *
 * 它以为 `.app-sidebar` 是**常驻侧栏**，窄了就把文字收起来。
 * 但 `.app-sidebar` 只有一个使用者 —— `VaultView` 传给 `NavDrawer` 的那个 rail。
 * **不存在另一个「常驻侧栏」元素**：抽屉和侧栏是同一个元素，只是按容器宽度
 * 换了两套定位。而那两档正好互补 —— `.app-sidebar` 以抽屉形态可见时，
 * 容器一定 < 900px，也就是这条规则**一定生效**。
 *
 * 结果：抽屉一拉开，就是 214px 宽、一个标签都没有的图标条。
 *
 * ## 为什么只有截图能发现它
 *
 * 类型检查、单测、构建全都不看 CSS。而**截图要看出来，必须把抽屉拉开再拍** ——
 * 之前核「手机视口」那一轮只截了抽屉关着的样子（汉堡按钮在、排版对），
 * 于是它从旁边溜过去了。
 *
 * 所以这条守卫的价值在于：它把「必须拉开抽屉才看得见」变成「改错了就红」。
 */
const FILES = import.meta.glob(['/apps/desktop/src/styles.css'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const css = Object.entries(FILES).find(([k]) => k.endsWith('styles.css'))?.[1] ?? '';

/** 有没有规则在 `.app-sidebar` 里把**文字**藏掉 */
function hidesTextInSidebar(source: string): boolean {
  return /\.app-sidebar[^{}]*\.(nav-label|nav-brand-text|nav-count|nav-section-title|nav-kbd)[^{}]*\{[^}]*display:\s*none/.test(source);
}

describe('抽屉的 CSS', () => {
  it('glob 读到了 styles.css（否则下面两条是空转的）', () => {
    expect(css.length).toBeGreaterThan(0);
  });

  /*
   * ⚠️ 先验判据本身能认出那段被删掉的规则。
   *
   * 不验的话，这条守卫可能因为正则写错而**永远绿** —— 而一个永远绿的守卫
   * 比没有守卫更糟：它给的是「有人在看着」的错觉。这个仓库里已经栽过一次
   * （safe-area 那条第一版匹配到了文档注释）。
   */
  it('判据确实能认出那段已经被删掉的规则', () => {
    const 删掉的那段 = `
      @container shell (max-width: 900px) {
        .app-sidebar .nav-label,
        .app-sidebar .nav-brand-text,
        .app-sidebar .nav-count { display: none; }
      }
    `;
    expect(hidesTextInSidebar(删掉的那段)).toBe(true);
  });

  it('现在没有任何规则在 .app-sidebar 里藏文字', () => {
    expect(
      hidesTextInSidebar(css),
      '.app-sidebar 是**浮层**（抽屉），不是常驻侧栏 —— 宽度是自己的，\n' +
        '不跟内容抢地方，所以它没有「收窄」这一档：要么关着，要么完整展开。\n' +
        '在这里藏掉标签，等于让抽屉拉开后只剩一排图标。',
    ).toBe(false);
  });
});
