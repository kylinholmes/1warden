import { useLocalStore, useStoreField } from '@1warden/state/react';
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
 * ## 从本地品牌到一定可用的兜底
 *
 * 1. 收录的服务品牌 —— 按完整域名匹配本地图标，无需网络
 * 2. 其他站点图标 —— 从服务端取，真实、可辨认
 * 3. 彩色字母徽标 —— 取不到站点图标时，由**条目名**算出来，颜色由域名算，
 *    同一站点的多条登录颜色一致
 * 4. 类型图标（着色）—— 卡片、笔记、身份这些**没有站点**的条目，
 *    光看字母认不出它是张卡；保留类型形状、用条目自己的色相着色
 *
 * ⚠️ 字母兜底不是「降级」那种将就。出网受限时 favicon 可能抓不到，
 * 所以字母徽标也必须好看。
 *
 * ## 两个入口
 *
 * `ItemIcon` 收显示字段：桌面端用 `iconPropsOf` 从条目计算；快速面板和
 * 扩展弹窗用后台随摘要提供的同一组字段。`IconGlyph` 只是内部渲染实现，
 * 各个入口都通过 `ItemIcon`，规则就不会在几处之间长歪。
 */
import { useEffect } from 'react';
import { avatarOf, displayDomainOf, iconDomainOf, type VaultItem } from '@1warden/vault';
import type { IconStore } from '@1warden/vault';
import { TypeIcon } from './icons';
import { cardBrandLogo } from './card-brand';
import { serviceBrandLogo } from './service-brand';

/** Only near-black, neutral single-color library paths receive theme contrast.
 * Official image assets never use this treatment, even when their pixels are black. */
function themeMonochrome(color: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return false;
  const channels = color.slice(1).match(/../g)!.map(channel => parseInt(channel, 16));
  return Math.max(...channels) <= 64 && Math.max(...channels) - Math.min(...channels) <= 12;
}

/**
 * 图标要的四样东西。
 *
 * ⚠️ **这里收的是显示所需的字段，不是整个 `VaultItem`。**
 *
 * 以前它收 `VaultItem`，于是在视图里现算 `avatarOf` / `iconDomainOf` ——
 * 而扩展端**拿不到 `VaultItem`**（弹窗只收摘要，spec 不变量 S1），
 * 只能自己拿摘要里那三个字段**直接调 `IconGlyph`**，绕过这个组件。
 *
 * 同一件事两条路径：`ItemIcon` 将来改点什么（加个兜底、改尺寸规则、
 * 处理 store 未命中），弹窗那条不会跟着动，而界面上看不出来 ——
 * 这正是这个仓库里反复出现的那一族，只是换了个地方长。
 *
 * 改成收字段之后，两端都走这一个组件：桌面端用下面的 `iconPropsOf`
 * 从完整条目算，扩展端用后台随摘要送过来的那几个字段。
 */
export interface IconProps {
  iconDomain: string | null;
  text: string;
  hue: number;
  type: string;
  cardBrand?: string | null | undefined;
}

/**
 * 从完整条目算出图标要的字段 —— **桌面端专用**。
 *
 * 扩展端在后台算好同样的值随摘要过来，所以那边不调这个函数。
 * 两边的算法必须是同一套：`avatarOf` / `iconDomainOf` 都在
 * `@1warden/vault` 里，一处定义。
 */
export function iconPropsOf(item: VaultItem): IconProps {
  const avatar = avatarOf(item);
  return { iconDomain: iconDomainOf(item), text: avatar.text, hue: avatar.hue, type: item.type,
    ...(item.type === 'card' ? { cardBrand: item.card?.brand ?? null } : {}) };
}

export function ItemIcon({ iconDomain, text, hue, type, cardBrand, store, size }: IconProps & {
  store: IconStore | null;
  /** 块边长。默认 34px（列表行）—— 详情栏头部用 36 */
  size?: number;
}) {
  return (
    <IconGlyph
      domain={iconDomain}
      text={text}
      hue={hue}
      type={type}
      cardBrand={cardBrand}
      store={store}
      {...(size === undefined ? {} : { size })}
    />
  );
}

export function IconGlyph({ domain, text, hue, type, cardBrand, store, size }: {
  domain: string | null;
  text: string;
  hue: number;
  type: string;
  cardBrand?: string | null | undefined;
  store: IconStore | null;
  size?: number;
}) {
  const brand = type !== 'card' ? serviceBrandLogo(domain) : null;
  const viewStore = useLocalStore(() => {
    const image = null as { domain: string; owner: IconStore; url: string } | null;
    return { image };
  });
  const [image, setImage] = useStoreField(viewStore, 'image');
  const url = image?.domain === domain && image?.owner === store ? image.url : null;

  useEffect(() => {
    // 换了条目就把上一个的图标清掉，否则会先显示上一条的图标再换 ——
    // 列表滚动时那一下闪烁很明显
    setImage(null);
    if (brand !== null || type === 'card' || domain === null || store === null) return;

    let alive = true;
    // 内建图标用完整主机名；未收录站点保留原来的基础域名缓存与请求路径。
    void store.get(displayDomainOf(domain) ?? domain).then((u) => {
      // 组件可能已经卸载、或者条目已经换了 —— 迟到的结果不能再写进去
      if (alive && u !== null) setImage({ domain, owner: store, url: u });
    });
    return () => { alive = false; };
  }, [store, domain, type, brand]);

  /*
   * 尺寸走 CSS 变量而不是内联 width/height —— 三个类各自就是那个方块，
   * 内联尺寸会和它们的规则打架（谁赢取决于顺序，而那不是能靠读代码看出来的）。
   *
   * ⚠️ **下面每个分支都要带上它。** 早先 `<img>` 那一支漏了，后果不是「图标
   * 小一点」而是：`size={36}` 时先按 36px 渲染（还没有 favicon，走徽标那支），
   * favicon 一到位就跳回 34px —— 一次看得见的闪动，而且只在图标**存在**的
   * 站点上出现，所以很容易被当成错觉。
   */
  const style = {
    '--h': String(hue),
    ...(size === undefined ? {} : { '--tile-size': `${size}px` }),
  } as React.CSSProperties;

  const network = type === 'card' ? cardBrandLogo(cardBrand) : null;
  if (network) return <span className="tile-card-brand" style={style} title={network.name} data-card-brand={network.id}>
    <img src={network.src} alt={network.name} draggable={false} />
  </span>;

  if (brand) return <span className="tile-service-brand" style={style} title={brand.name} data-service-brand={brand.id}>
    {brand.src ? <img src={brand.src} alt="" draggable={false} /> : <svg viewBox="0 0 24 24" fill={brand.color}
      className={themeMonochrome(brand.color) ? 'brand-monochrome' : undefined}
      style={{ '--brand-ink': brand.color } as React.CSSProperties} aria-hidden="true" focusable="false">
      <path d={brand.path} />
    </svg>}
  </span>;

  if (url !== null && type !== 'card') {
    // alt 留空：紧接着就是条目的名字，读屏软件念两遍同一个东西反而更糟
    return <img src={url} alt="" className="tile-img" style={style} draggable={false} />;
  }

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
