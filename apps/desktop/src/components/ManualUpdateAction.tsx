import { useLocalStore, useStoreField } from '@1warden/state/react';
import { openWebsite } from '../open-website';
import { RELEASES_URL } from '../updates/manual';
import { IS_MOBILE } from '@1warden/ui';

export default function ManualUpdateAction() {
  const store = useLocalStore(() => ({ failed: false }));
  const [failed, setFailed] = useStoreField(store, 'failed');
  // Mobile uses its original distribution channel; the desktop browser-launch
  // command is unavailable there. Keep the release address selectable.
  if (IS_MOBILE) return <p className="select-text break-all text-xs text-[var(--ink-secondary)]">发布说明：{RELEASES_URL}</p>;
  return <div>
    <button type="button" className="btn btn-quiet" onClick={() => {
      void openWebsite(RELEASES_URL).catch(() => setFailed(true));
    }}>前往更新</button>
    {failed && <p role="alert" className="mt-2 select-text break-all text-xs text-[var(--risk)]">
      无法打开浏览器，请通过原安装渠道更新，或在浏览器访问：{RELEASES_URL}
    </p>}
  </div>;
}
