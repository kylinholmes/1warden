/**
 * 一个**只够用**的 XML 解析器。
 *
 * ## 为什么要自己写
 *
 * 现实约束：MV3 的 service worker 里**没有 `DOMParser`**，而 `@coffer/vault`
 * 要在扩展里跑。引一个 XML 库则要连 DOM 仿真一起引进来 —— 为了一份
 * KeePass 导出的解析，代价太大。
 *
 * ## 它**不**支持什么（刻意的）
 *
 * DTD、命名空间、处理指令（XML 声明除外）、`<![INCLUDE[...]]>`。
 * KeePass 与 1Password 的导出只用得到元素、属性、文本、CDATA 和字符实体。
 *
 * ## ⚠️ 遇到不认识的输入**抛错**，不猜
 *
 * 半棵树比没有树更糟：用户看到的是「导入了 200 条，跳过了 0 条」，
 * 而另外 300 条静默消失了 —— 他会以为导出文件就是这样。
 * 标签不闭合、标签不匹配，一律抛。
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** 直接文本内容（已解码实体，已去除首尾空白） */
  text: string;
}

/** 命名实体。`&amp;` 必须最后替换，否则 `&amp;lt;` 会被解成 `<` */
const NAMED: Record<string, string> = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&',
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** 标签名：到空白或 `/` 或 `>` 为止 */
const NAME = /[^\s/>]+/;
/** 属性：`名="值"` 或 `名='值'` */
const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;

  const top = (): XmlElement => stack[stack.length - 1]!;

  while (i < source.length) {
    const lt = source.indexOf('<', i);

    if (lt < 0) {
      // 剩下的全是文本
      const tail = source.slice(i);
      if (tail.trim().length > 0) top().text += decodeEntities(tail.trim());
      break;
    }

    if (lt > i) {
      const chunk = source.slice(i, lt);
      // ⚠️ 元素之间的缩进与换行不算内容。不 trim 的话，每个值都会带上
      // 导出文件里的那层缩进，而用户完全看不出它们是怎么来的
      if (chunk.trim().length > 0) top().text += decodeEntities(chunk.trim());
    }

    // 注释 / CDATA / 声明
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('XML 损坏：注释没有闭合');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('XML 损坏：CDATA 没有闭合');
      // CDATA 里的内容**原样**收下，不做实体解码
      top().text += source.slice(lt + 9, end).trim();
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('XML 损坏：处理指令没有闭合');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      // DOCTYPE 之类 —— 我们不需要，但也不能卡住
      const end = source.indexOf('>', lt + 2);
      if (end < 0) throw new Error('XML 损坏：声明没有闭合');
      i = end + 1;
      continue;
    }

    // 结束标签
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt + 2);
      if (end < 0) throw new Error('XML 损坏：结束标签没有闭合');
      const name = source.slice(lt + 2, end).trim();
      if (stack.length <= 1) throw new Error(`XML 损坏：多出来的结束标签 </${name}>`);
      const open = stack.pop()!;
      if (open.name !== name) {
        throw new Error(`XML 损坏：<${open.name}> 与 </${name}> 不匹配`);
      }
      i = end + 1;
      continue;
    }

    // 开始标签
    const end = source.indexOf('>', lt + 1);
    if (end < 0) throw new Error('XML 损坏：开始标签没有闭合');

    const selfClosing = source[end - 1] === '/';
    const inner = source.slice(lt + 1, selfClosing ? end - 1 : end);

    const nameMatch = NAME.exec(inner);
    if (nameMatch === null) throw new Error('XML 损坏：标签没有名字');
    const name = nameMatch[0];

    const attrs: Record<string, string> = {};
    ATTR.lastIndex = name.length;
    for (let m = ATTR.exec(inner); m !== null; m = ATTR.exec(inner)) {
      // 双引号与单引号两种写法，取有的那个
      attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
    }

    const el: XmlElement = { name, attrs, children: [], text: '' };
    top().children.push(el);
    if (!selfClosing) stack.push(el);

    i = end + 1;
  }

  if (stack.length > 1) {
    throw new Error(`XML 损坏：<${stack[stack.length - 1]!.name}> 没有闭合`);
  }

  return root;
}

/** 按 `a.b.c` 这样的路径找子元素。路径里每一段都是元素名 */
export function xmlChildren(el: XmlElement, path: string): XmlElement[] {
  let current: XmlElement[] = [el];
  for (const part of path.split('.')) {
    const next: XmlElement[] = [];
    for (const c of current) for (const child of c.children) if (child.name === part) next.push(child);
    current = next;
  }
  return current;
}

/** 按路径找第一个元素的文本；找不到返回 '' */
export function xmlText(el: XmlElement, path: string): string {
  return xmlChildren(el, path)[0]?.text ?? '';
}

export function xmlAttr(el: XmlElement, name: string): string | null {
  return el.attrs[name] ?? null;
}
