import type { CapturePreview, CaptureChoice } from '../src/application/browser-credentials';
import type { FormCapture } from './capture-service';

export type CaptureNotice = Pick<CapturePreview, 'id' | 'revision' | 'url' | 'username' | 'action'>;
export interface CredentialDocumentReply { unlocked: boolean; token: string | null; notices: CaptureNotice[] }
export interface GeneratorSettings { length: number; digits: boolean; symbols: boolean }
export interface GenerationTarget {
  formId: string; targetId: string; passwordIndex: number; confirmIndex: number | null; minLength: number; maxLength: number;
  needsReplacement: boolean;
}
export interface GenerationFillGrant { formId: string; targetId: string; token: string }
/** Lives in the ISOLATED world only. Background invokes it through one-shot injection. */
export interface CredentialDocumentBridge {
  nonce: string;
  describe(index: number): Promise<GenerationTarget | null>;
  fill(index: number, password: string, replace: boolean, expected: GenerationFillGrant): Promise<{ ok: boolean; error?: string }>;
}
export type CredentialRequest =
  | { type: '1warden:credential-document'; nonce: string }
  | { type: '1warden:credential-capture'; nonce: string; token: string; input: FormCapture }
  | { type: '1warden:credential-username'; nonce: string; token: string; username: string }
  | { type: '1warden:credential-generate'; nonce: string; token: string; formId: string; targetId: string; passwordIndex: number; settings: GeneratorSettings; replace: boolean }
  | { type: '1warden:credential-review'; id: string; nonce: string; token: string }
  | { type: '1warden:credential-snooze'; id: string; nonce: string; token: string }
  | { type: '1warden:credential-list'; captureId?: string }
  | { type: '1warden:credential-save'; choice: CaptureChoice }
  | { type: '1warden:credential-dismiss'; id: string }
  | { type: '1warden:credential-history' }
  | { type: '1warden:credential-reveal-history'; id: string }
  | { type: '1warden:credential-delete-history'; id: string }
  | { type: '1warden:credential-recover-history'; id: string };

/** Self-contained functions: executeScript serializes these without their module closure. */
export function credentialDocumentMatches(nonce: string): boolean {
  return (globalThis as unknown as { __onewardenCredential?: CredentialDocumentBridge }).__onewardenCredential?.nonce === nonce;
}
export async function inspectGeneration(nonce: string, index: number): Promise<GenerationTarget | null> {
  const bridge = (globalThis as unknown as { __onewardenCredential?: CredentialDocumentBridge }).__onewardenCredential;
  if (!bridge || bridge.nonce !== nonce) return null;
  return bridge.describe(index);
}
export async function injectGeneratedPassword(nonce: string, index: number, password: string, replace: boolean, expected: GenerationFillGrant): Promise<{ ok: boolean; error?: string }> {
  const bridge = (globalThis as unknown as { __onewardenCredential?: CredentialDocumentBridge }).__onewardenCredential;
  if (!bridge || bridge.nonce !== nonce) return { ok: false, error: '网页已改变，请重新生成' };
  return bridge.fill(index, password, replace, expected);
}
