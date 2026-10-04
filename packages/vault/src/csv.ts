/**
 * CSV 解析（RFC 4180 + 真实世界的那点宽容）。
 *
 * 为什么自己写而不是引一个库：需要的只有下面这一百来行，而导入是**一次性
 * 但不可重来**的操作 —— 解析错了用户就得重新导出、重新导入，还可能已经
 * 写进去半份数据。自己写能把每个边界都钉上测试。
 *
 * 宽容的地方只朝一个方向：**宁可多留内容，不可丢内容**。
 * 遇到不合规的输入（未闭合的引号、参差的行）按字面收下，而不是抛错 ——
 * 抛错会让整次导入失败，而用户手里只有那一份导出文件。
 */

/**
 * 解析成二维字符串数组。
 *
 * 不返回「对象数组」：列名在真实导出里千奇百怪（大小写、空格、BOM），
 * 映射成对象是调用方的事，那一步也各有各的规则。
 */
export function parseCsv(text: string): string[][] {
  // ⚠️ BOM 必须先剥掉。Excel 导出的 CSV 带 UTF-8 BOM，留着的话第一个列名
  // 前面会多一个不可见字符 —— 「按列名找字段」于是永远找不到，
  // 而文件在编辑器里看起来完全正常。这类问题极难排查。
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  /** 这一行有没有出现过任何东西 —— 用来识别真正的空行 */
  let touched = false;

  const endField = (): void => { row.push(field); field = ''; };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    touched = false;
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }  // 转义的引号
        inQuotes = false; i += 1; continue;
      }
      field += ch; touched = true; i += 1; continue;
    }

    if (ch === '"' && field.length === 0) { inQuotes = true; touched = true; i += 1; continue; }
    if (ch === ',') { endField(); touched = true; i += 1; continue; }
    if (ch === '\r') {
      // CRLF 与单独的 CR 都当换行
      endRow();
      i += src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') { endRow(); i += 1; continue; }

    field += ch; touched = true; i += 1;
  }

  // 文件不以换行结尾时在这里收尾。
  if (touched || field.length > 0 || row.length > 0) endRow();

  /*
   * 只在**末尾**丢掉一个空行 —— 那是结尾换行的产物，不是数据。
   *
   * ⚠️ 这里刻意**不**在 endRow 里跳过空行。那样写会让行为不可观测：
   * CRLF 若被当成两个换行，会多出一个空行 —— 而「跳过空行」正好把它吃掉，
   * 两种实现输出完全一样，测试再也分不出对错（这一点是变异检验逼出来的）。
   * 中间真正的空行照实保留，由调用方按列数不足自行忽略。
   */
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }

  return rows;
}
