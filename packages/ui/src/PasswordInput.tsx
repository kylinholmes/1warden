import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type Ref } from 'react';
import { IconEye } from './icons';

/** Authentication field with an independently named reveal control. */
export function PasswordInput({ ref, className = '', value, disabled, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  ref?: Ref<HTMLInputElement>;
}) {
  const store = useLocalStore(() => ({ visible: false }));
  const [visible, setVisible] = useStoreField(store, 'visible');
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!, []);
  useEffect(() => { if (!value) setVisible(false); }, [value]);
  return <div className="auth-password">
    <input {...props} ref={input} value={value} disabled={disabled} type={visible ? 'text' : 'password'} className={`field secret ${className}`} />
    <button type="button" className="btn btn-ghost auth-password-toggle" disabled={disabled}
      aria-label={visible ? '隐藏主密码' : '显示主密码'} aria-pressed={visible}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { setVisible(!visible); input.current?.focus(); }}><IconEye size={18} off={visible} /></button>
  </div>;
}
