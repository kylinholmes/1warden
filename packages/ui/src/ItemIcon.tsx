/**
 * 列表行左侧那个方块 —— 有条目自己的图标，而不是按类型共用一个。
 *
 * ## 为什么值得单独做一个组件
 *
 * 原本这里是 `TypeIcon`：所有登录都是同一把蓝色钥匙，所有卡片都是同一张
 * 蓝色卡片。信息量是有的（能分清类型），但**一眼认不出来是哪一条** ——
 * 一列看下去全是同样的形状同样的颜色。
 *
 * 1Password 那一列之所以扫一眼就知道谁是谁，靠的是每条有自己的图标：
 * 有站点的显示站点图标（bilibili 的头像、GitHub 的章鱼猫），
 * 没有的就显示一条彩色字母徽标（「Zlib」是紫底 Zl、「基金从业」是金底基金）。
 *
 * ## 三层，从「最准」到「一定有」
 *
 * 1. 站点图标 —— 从服务端取，真实、可辨认
 * 2. 彩色字母徽标 —— 取不到站点图标时，由**条目名**算出来，颜色由域名算，
 *    同一站点的多条登录颜色一致
 * 3. 类型图标（着色）—— 卡片、笔记、身份这些**没有站点**的条目，
 *    光看字母认不出它是张卡；保留类型形状、用条目自己的色相着色
 *
 * ⚠️ 第 2 层不是「降级」那种将就。本地开发环境的出网是受限的，
 * 大部分 favicon 抓不到，所以第 2 层才是常态 —— 它必须好看。
 *
 * ## 两个入口
 *
 * `ItemIcon` 收条目、`IconGlyph` 收算好的字段。后者是给**拿不到 VaultItem
 * 的地方**用的（快速面板在另一个窗口、扩展端的弹窗只拿到摘要）——
 * 字段由有 VaultItem 的那一方算好过桥。两条路共用这一个实现，
 * 规则就不会在几处之间长歪。
 */
import { useEffect, useState } from 'react';
import { avatarOf, iconDomainOf, type VaultItem } from '@coffer/vault';
import type { IconStore } from '@coffer/vault';
import { TypeIcon } from './icons';

export function ItemIcon({ item, store, size }: {
  item: VaultItem; store: IconStore | null;
  /** 块边长。默认 34px（列表行）—— 详情栏头部用 36 */
  size?: number;
}) {
  const avatar = avatarOf(item);
  return (
    <IconGlyph
      domain={iconDomainOf(item)}
      text={avatar.text}
      hue={avatar.hue}
      type={item.type}
      store={store}
      {...(size === undefined ? {} : { size })}
    />
  );
}

export function IconGlyph({ domain, text, hue, type, store, size }: {
  domain: string | null;
  text: string;
  hue: number;
  type: string;
  store: IconStore | null;
  size?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // 换了条目就把上一个的图标清掉，否则会先显示上一条的图标再换 ——
    // 列表滚动时那一下闪烁很明显
    setUrl(null);
    if (domain === null || store === null) return;

    let alive = true;
    void store.get(domain).then((u) => {
      // 组件可能已经卸载、或者条目已经换了 —— 迟到的结果不能再写进去
      if (alive) setUrl(u);
    });
    return () => { alive = false; };
  }, [store, domain]);

  if (url !== null) {
    // alt 留空：紧接着就是条目的名字，读屏软件念两遍同一个东西反而更糟
    return <img src={url} alt="" className="tile-img" draggable={false} />;
  }

  /*
   * 尺寸走 CSS 变量而不是内联 width/height —— 三个类各自就是那个方块，
   * 内联尺寸会和它们的规则打架（谁赢取决于顺序，而那不是能靠读代码看出来的）。
   */
  const style = {
    '--h': String(hue),
    ...(size === undefined ? {} : { '--tile-size': `${size}px` }),
  } as React.CSSProperties;

  // 没有站点的条目（卡片、笔记、身份、SSH 密钥）保留类型形状 ——
  // 「ZA 信用卡」和「我的邮箱」都变成两个汉字的话，就看不出哪个是卡了
  if (domain === null) {
    return (
      <span className="tile-glyph" style={style}>
        <TypeIcon type={type} size={17} />
      </span>
    );
  }

  return <span className="tile-avatar" style={style}>{text}</span>;
}
