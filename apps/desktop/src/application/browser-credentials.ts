/** Display-only browser credential contracts. Secret values require a trusted UI action. */
export interface CaptureTarget { id: string; title: string; username: string; updatedAt: string }
export interface CapturePreview {
  id: string; revision: number; tabId: number | null; url: string; username: string | null;
  action: 'save' | 'update' | 'review'; itemId: string | null; targets: CaptureTarget[];
  createdAt: number; snoozed: boolean; source: 'form' | 'history';
}
export interface CaptureChoice {
  captureId: string; revision: number; action: 'save' | 'update';
  itemId?: string; targetUpdatedAt?: string; username?: string;
}
export interface GeneratedPasswordSummary { id: string; url: string; createdAt: number }
export interface BrowserCredentialActions {
  list(): Promise<CapturePreview[]>;
  save(choice: CaptureChoice): Promise<void>;
  dismiss(id: string): Promise<void>;
  history(): Promise<GeneratedPasswordSummary[]>;
  revealHistory(id: string): Promise<string>;
  deleteHistory(id: string): Promise<void>;
  recoverHistory(id: string): Promise<CapturePreview>;
}
