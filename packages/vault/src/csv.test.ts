import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv —— 基本形状', () => {
  it('parses a simple table', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n')).toEqual([]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('parseCsv —— 换行', () => {
  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('does not emit a trailing empty row for a final newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('treats a lone CR as a line break', () => {
    // 老 Mac 的导出是纯 CR
    expect(parseCsv('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseCsv —— 引号', () => {
  it('lets a quoted field contain the delimiter', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']]);
  });

  it('lets a quoted field contain a newline', () => {
    expect(parseCsv('"line1\nline2",c')).toEqual([['line1\nline2', 'c']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""",c')).toEqual([['say "hi"', 'c']]);
  });

  /** ⚠️ 密码里出现引号是常事，这个不能错 */
  it('handles a password containing quotes and commas', () => {
    expect(parseCsv('a,"p@ss,""word"",1"')).toEqual([['a', 'p@ss,"word",1']]);
  });

  it('handles an empty quoted field', () => {
    expect(parseCsv('a,"",c')).toEqual([['a', '', 'c']]);
  });

  it('keeps quotes that are not at the start of a field', () => {
    // 不是 RFC 的严格用法，但真实导出里会见到，按字面保留比丢掉好
    expect(parseCsv('a b"c,d')).toEqual([['a b"c', 'd']]);
  });
});

describe('parseCsv —— 文件头', () => {
  /** ⚠️ Excel 导出的 CSV 带 UTF-8 BOM，不剥掉的话第一个列名会多一个不可见字符，
   *  于是「按列名找字段」永远找不到 —— 而且看起来完全正常，极难排查 */
  it('strips a UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseCsv —— 不该崩', () => {
  it('tolerates an unclosed quote', () => {
    // 宁可把剩下的都当成一个字段，也不要抛错让整个导入失败
    expect(() => parseCsv('a,"unclosed')).not.toThrow();
    expect(parseCsv('a,"unclosed')).toEqual([['a', 'unclosed']]);
  });

  it('tolerates ragged rows', () => {
    expect(parseCsv('a,b,c\n1,2')).toEqual([['a', 'b', 'c'], ['1', '2']]);
  });

  it('tolerates a quote inside an unquoted field', () => {
    expect(() => parseCsv('a"b,c')).not.toThrow();
  });
});
