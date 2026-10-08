import type { AccountTarget } from './account-target';
import type {
  UserProfile, ProfilePreferences, ProfileDeviceInput, ProfileSettings, AccountInfo, Attachment, CardFields, ConnectParams, IdentityFields,
  ImportFormatId, LoginUri, SessionStatus, VaultFolder, VaultItem,
} from '@1warden/vault';
import type { ImportOutcome, ImportPreview, ItemSummary, ReportBrief } from '@1warden/ui';

/** The UI sees a stable snapshot of display data, never a session or its keys. */
export interface ApplicationSnapshot {
  revision: number;
  status: SessionStatus;
  account: AccountInfo | null;
  syncing: boolean;
  profile: UserProfile | null;
  profileVersion: string | null;
  profileError: string | null;
  profileReady: boolean;
  /** Decrypted only while unlocked; device history is never cached in presentation storage. */
  profileSettings?: ProfileSettings | null;
  profileSettingsError?: string | null;
  items: ItemSummary[];
  folders: VaultFolder[];
  /** Canonical identity keys whose independent sessions are still unlocked. */
  unlockedAccounts?: string[];
}

export type SecretRef =
  | { kind: 'password' }
  | { kind: 'cardNumber' }
  | { kind: 'cardCode' }
  | { kind: 'privateKey' }
  | { kind: 'custom'; index: number }
  | { kind: 'history'; index: number };

/** A selected record's presentation. Secret values require an explicit reveal. */
export interface ItemDetailData {
  summary: ItemSummary;
  rawType: number;
  notes: string | null;
  notesFailed: boolean;
  login: { username: string | null; uris: LoginUri[]; hasPassword: boolean; hasTotp: boolean } | null;
  card: (Omit<CardFields, 'number' | 'code'> & { hasNumber: boolean; hasCode: boolean }) | null;
  identity: IdentityFields | null;
  sshKey: { publicKey: string | null; fingerprint: string | null; hasPrivateKey: boolean } | null;
  customFields: { name: string; value: string | null; type: 0 | 1 | 2 | 3; linkedId: number | null }[];
  passwordHistory: { lastUsedDate: string }[];
  attachments: Pick<Attachment, 'id' | 'fileName' | 'size' | 'sizeName' | 'failed'>[];
}

export interface ImportFile {
  name: string;
  dataBase64: string;
  format: ImportFormatId;
}

export interface SiteContext {
  tabId: number | null;
  url: string;
  matchedIds: string[];
  pending: { url: string; username: string | null; action: 'save' | 'update'; itemId: string | null } | null;
}

export interface ApplicationCapabilities {
  native: boolean;
  browser: boolean;
  saveAttachments: boolean;
}

/** Explicit operations, shared by the local service and the browser message bridge. */
export interface ApplicationService {
  snapshot(): Promise<ApplicationSnapshot>;
  connect(params: ConnectParams): Promise<void>;
  connectWithTwoFactor(code: string, provider: number, remember: boolean): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  logout(): Promise<void>;
  switchAccount(account: AccountTarget | null): Promise<void>;
  search(query: string): Promise<ItemSummary[]>;
  getItem(id: string): Promise<ItemDetailData>;
  /** Explicit edit action: editable fields only, without keys/passkeys/history/attachment internals. */
  getDraft(id: string): Promise<VaultItem>;
  saveProfile(profile: UserProfile, expectedVersion: string | null): Promise<void>;
  savePreferences(preferences: ProfilePreferences, expected: ProfilePreferences | null): Promise<void>;
  recordDevice(device: ProfileDeviceInput): Promise<void>;
  saveItem(draft: VaultItem): Promise<ItemSummary>;
  toggleFavorite(id: string): Promise<void>;
  moveToTrash(id: string): Promise<void>;
  deletePermanently(id: string): Promise<void>;
  createFolder(name: string): Promise<void>;
  renameFolder(id: string, name: string): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  reveal(id: string, field: SecretRef): Promise<string>;
  totp(id: string): Promise<{ code: string; remaining: number; period: number } | null>;
  downloadAttachment(id: string, attachmentId: string): Promise<{ fileName: string; dataBase64: string }>;
  securityReport(now: number): Promise<ReportBrief>;
  checkBreaches(): Promise<ReportBrief['breached']>;
  parseImport(file: ImportFile): Promise<ImportPreview>;
  importData(file: ImportFile): Promise<ImportOutcome>;
}

export interface BrowserActions {
  context(): Promise<SiteContext>;
  fill(itemId: string, tabId: number): Promise<void>;
  saveCapture(tabId: number): Promise<void>;
  dismissCapture(tabId: number): Promise<void>;
}

/** A failed login form, separate from remembered accounts and vault session data. */
export interface ConnectionDraft {
  serverUrl: string;
  email: string;
  error: string | null;
  /** Public origin identity, so cancelling Add Account can return to it. */
  returnAccount?: AccountTarget;
}

export interface ConnectionDraftStore {
  load(): Promise<ConnectionDraft | null>;
  save(draft: ConnectionDraft): Promise<void>;
  clear(): Promise<void>;
}

export interface ApplicationClient extends ApplicationService {
  capabilities: ApplicationCapabilities;
  browser?: BrowserActions;
  connectionDraft?: ConnectionDraftStore;
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
  saveFile(fileName: string, dataBase64: string): Promise<{ path: string | null }>;
}

export type ApplicationMethod = keyof ApplicationService;
export type ApplicationRequest = {
  [K in ApplicationMethod]: { type: '1warden:application'; method: K; args: Parameters<ApplicationService[K]> }
}[ApplicationMethod];

export const EMPTY_SNAPSHOT: ApplicationSnapshot = {
  revision: 0, status: 'loggedOut', account: null, syncing: false, items: [], folders: [], profile: null, profileVersion: null, profileError: null, profileReady: false,
};
