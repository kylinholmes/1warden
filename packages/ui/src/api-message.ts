/**
 * 把 `ApiError` 变成用户看得懂的话 —— **两端共用一份**。
 *
 * ## 为什么必须有这一份
 *
 * ⚠️ 不翻译的话，用户看到的是**服务端返回的原文**，而 Vaultwarden 的
 * 报错是英文的（`Username or password is incorrect. Try again`）。
 * 扩展端一直是这样 —— 用户截图里那一行英文就是它。
 *
 * 而翻译过的版本（桌面端有）把两件**后果完全不同**的事分开了：
 *
 *   密码错   → 重新输
 *   连不上   → 检查地址和网络
 *
 * 混成一句「出错了」的话，用户会去改配置，而问题其实在密码。
 * 解锁屏对这个区分有明确要求（见 spec）。
 *
 * ⚠️ 桌面端原来有**三份**（连接屏 / 编辑器 / 解锁屏），措辞已经略有不同
 * （`连不上服务器，请检查地址与网络` / `连不上服务器，改动尚未保存` /
 * `连不上服务器`）。那三处的**前缀**故意统一到这里，各自的**后缀**
 * （「改动尚未保存」那种上下文补充）由调用方自己加。
 */
export function apiMessageOf(err: unknown): string {
  const kind = (err as { kind?: string } | null)?.kind;
  switch (kind) {
    case 'network': return '连不上服务器，请检查地址与网络';
    case 'timeout': return '服务器响应超时';
    case 'auth': return '邮箱或主密码不正确';
    case 'rateLimited': return '尝试过于频繁，请稍后再试';
    case 'malformedResponse': return '服务器返回了无法理解的响应，可能不是 Vaultwarden';
    case 'certUntrusted': return '服务器证书无法验证';
    case 'server': return '服务器出错了';
    /* 没有 `kind` 的（不是 ApiError）—— 原样透出，但**不吞**：
       吞掉的话「点了没反应」会变成查不出原因的问题 */
    default: return err instanceof Error ? err.message : '未知错误';
  }
}
