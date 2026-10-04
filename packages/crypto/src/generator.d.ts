export declare const POOLS: {
    readonly lowercase: "abcdefghijklmnopqrstuvwxyz";
    readonly uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    readonly digits: "0123456789";
    readonly symbols: "!@#$%^&*()_+-=[]{}|;:,.<>?";
};
export interface PasswordOptions {
    length?: number;
    lowercase?: boolean;
    uppercase?: boolean;
    digits?: boolean;
    symbols?: boolean;
    avoidAmbiguous?: boolean;
}
export declare function generatePassword(opts?: PasswordOptions): string;
export interface PassphraseOptions {
    words?: number;
    separator?: string;
    capitalize?: boolean;
    includeNumber?: boolean;
}
export declare function generatePassphrase(opts?: PassphraseOptions): string;
export declare function estimateEntropyBits(password: string, poolSize: number): number;
export declare function passwordStrength(pw: string): {
    score: 0 | 1 | 2 | 3 | 4;
    entropyBits: number;
};
