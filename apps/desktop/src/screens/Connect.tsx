import { useState } from 'react';
import type { VaultClient, TwoFactorChallenge } from '@coffer/vault';
import { probeCertificate, trustCertificate, type CertInfo } from '../trust';
import {
  ConnectScreen, IconLock, IconSpinner, apiMessageOf, rememberAccount, useAccounts,
  type ConnectCreds,
} from '@coffer/ui';

/**
 * 连接 / 解锁 —— **桌面端这里只剩外壳和平台专有的那一屏**。
 *
 * 界面本体在 `@coffer/ui` 的 `ConnectScreen`，和扩展弹窗**同一份代码**
 * （账户列表、快速解锁、表单、两步验证都在那边）。这里负责三件共享组件
 * 不该知道的事：
 *
 * 1. **连接动作**：直接调 `VaultClient`（扩展端是发消息给后台）
 * 2. **证书确认**：走 Rust 的 `probeCertificate` / `trustCertificate`。
 *    扩展端**没有**这条路 —— TLS 校验在浏览器手里，自签证书只能靠
 *    系统信任库解决。所以它是塞进 `ConnectScreen` 的一个插槽。
 * 3. **窗口拖动**：这一屏没有顶部带子，整块背景就是可拖区域
 *    （见下面 `data-tauri-drag-region` 的说明）。
 */

interface Props {
  client: VaultClient;
  onConnected: () => void;
}

function isTwoFactor(e: unknown): e is TwoFactorChallenge & { __twoFactor: true } {
  return typeof e === 'object' && e !== null && (e as { twoFactorRequired?: boolean }).twoFactorRequired === true;
}

function isCertUntrusted(e: unknown): e is { kind: 'certUntrusted'; fingerprint?: string } {
  return (e as { kind?: string } | null)?.kind === 'certUntrusted';
}

export function Connect({ client, onConnected }: Props) {
  const accounts = useAccounts();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [cert, setCert] = useState<CertInfo | null>(null);
  /**
   * 触发证书确认的那一次凭据。
   *
   * ⚠️ 必须留一份：用户核对完证书之后要**原样重跑一次连接**，而那时候
   * 表单已经不在屏幕上了（`cert` 插槽盖住了它），拿不回那两个字段。
   */
  const [pending, setPending] = useState<ConnectCreds | null>(null);

  async function doConnect(c: ConnectCreds) {
    setBusy(true);
    setError(null);
    try {
      await client.connect({
        serverUrl: c.serverUrl, email: c.email, masterPassword: c.masterPassword,
      });
      // 只记住服务器与邮箱 —— **绝不**记住主密码。不 await：它是便利功能，
      // 而且 `rememberAccount` 自己就不抛
      void rememberAccount({ serverUrl: c.serverUrl, email: c.email });
      onConnected();
    } catch (err) {
      if (isTwoFactor(err)) {
        setChallenge({ providers: err.providers, providersInfo: err.providersInfo });
      } else if (isCertUntrusted(err)) {
        setPending(c);
        await offerCertificate(c.serverUrl);
      } else {
        setError(apiMessageOf(err));
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * 证书验证失败时的处理。
   *
   * ⚠️ 这里**不**自动重试、也不自动信任：证书有问题既可能是自建服务器的
   * 自签证书（正常），也可能是有人在中间截获连接（危险）。这两种情况从
   * 客户端这边看不出来，只有用户自己知道那台服务器是不是他的。所以把
   * 证据摆出来，让用户拍板。
   */
  async function offerCertificate(url: string) {
    try {
      setCert(await probeCertificate(url));
    } catch (e) {
      setError(apiMessageOf(e));
    }
  }

  async function submitCode(code: string, provider: number, remember: boolean) {
    setBusy(true);
    setError(null);
    try {
      await client.connectWithTwoFactor(code, provider, remember);
      onConnected();
    } catch (err) {
      setError(apiMessageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function trustAndRetry() {
    if (!cert || !pending) return;
    setBusy(true);
    try {
      await trustCertificate(pending.serverUrl, cert.fingerprint);
      setCert(null);
    } catch (e) {
      setError(apiMessageOf(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    await doConnect(pending);
  }

  return (
    /*
      这一屏没有顶部带子（内容居中），所以整块背景就是可拖的区域 ——
      自绘标题栏之后没有原生标题栏可以抓，窗口必须能从某处拖走。

      `="deep"` 是「这一层里任何地方都能拖」，而按钮、输入框、链接
      这些**可交互元素自动豁免**（Tauri 的 drag.js 里那张表），
      所以表单该点点、该打字打字，只有空白和文字处能拖着窗口走。
      不带值的写法只在**正好按在那张元素本身**时才拖 —— 而这一屏的
      背景几乎都被卡片盖着，那样等于哪儿都拖不动。
    */
    <div className="below-titlebar flex h-full items-center justify-center overflow-y-auto bg-[var(--surface-canvas)] p-8" data-tauri-drag-region="deep">
      <div className="screen-in w-full max-w-[380px]">
        <ConnectScreen
          accounts={accounts}
          busy={busy}
          error={error}
          challenge={challenge}
          /* 扩展端不传这一项 —— 那条路在浏览器里不存在 */
          cert={cert ? (
            <CertificatePrompt
              cert={cert}
              host={hostOf(pending?.serverUrl ?? '')}
              busy={busy}
              onCancel={() => setCert(null)}
              onTrust={() => { void trustAndRetry(); }}
            />
          ) : undefined}
          brand={
            <>
              <span className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-ink)]">
                <IconLock size={17} />
              </span>
              <span className="text-xl font-semibold tracking-[-0.01em]">Coffer</span>
            </>
          }
          onSubmit={(c) => { void doConnect(c); }}
          onTwoFactor={({ code, provider, remember }) => { void submitCode(code, provider, remember); }}
        />
      </div>
    </div>
  );
}

/**
 * 证书确认。
 *
 * 设计取向：**危险的那个动作不做成默认按钮**。这里默认、显眼的选项是「取消」，
 * 「信任并继续」要用户主动去点。一排按钮里最顺手的那个不该是不可逆的选择。
 */
function CertificatePrompt(props: {
  cert: CertInfo;
  host: string;
  busy: boolean;
  onCancel: () => void;
  onTrust: () => void;
}) {
  const { cert } = props;
  return (
    <div className="space-y-4">
      <p className="text-sm leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
        <strong className="font-medium text-[var(--ink-primary)]">{props.host}</strong>{' '}
        出示的证书无法验证。自建服务器用自签证书是正常的；但也可能是有人
        在中间截获了这次连接 —— 这两种情况从这边看不出来。
      </p>

      <dl className="card-well space-y-2.5 p-4 text-xs">
        <Row label="指纹">
          <span className="secret break-all text-xs">{cert.fingerprint}</span>
        </Row>
        <Row label="签发给"><span className="truncate">{cert.subject}</span></Row>
        <Row label="签发者"><span className="truncate">{cert.issuer}</span></Row>
        <Row label="有效期">
          <span className="tabular-nums">{shortDate(cert.notBefore)} 至 {shortDate(cert.notAfter)}</span>
        </Row>
      </dl>

      <p className="text-xs leading-relaxed text-[var(--ink-tertiary)]">
        请与服务器管理员核对上面的指纹（服务器上执行{' '}
        <code className="secret">openssl x509 -noout -fingerprint -sha256 -in 证书文件</code>
        ）。核对一致才能继续。
      </p>

      <div className="flex flex-col gap-2 pt-1">
        <button type="button" onClick={props.onCancel} disabled={props.busy}
          className="btn btn-primary w-full py-2.5">
          取消
        </button>
        <button type="button" onClick={props.onTrust} disabled={props.busy}
          className="btn btn-quiet w-full gap-2 py-2.5 text-[var(--caution)]">
          {props.busy && <IconSpinner size={14} />}
          {props.busy ? '正在继续…' : '我已核对，信任这张证书并继续'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-14 shrink-0 text-[var(--ink-tertiary)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[var(--ink-secondary)]">{children}</dd>
    </div>
  );
}

/** 只用于展示的主机名 —— 真正的 host:port 解析在 Rust 侧，这里不参与逻辑 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Rust 侧给的是 RFC 2822 字符串；解析不了就原样显示，不要显示成 Invalid Date */
function shortDate(value: string): string {
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toLocaleDateString('zh-CN');
}
