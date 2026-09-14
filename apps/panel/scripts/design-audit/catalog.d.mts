export declare const CAPABILITY_CATALOG: readonly { key: string; enabled: boolean; supported: boolean }[];
export declare const CAPABILITY_KEYS: readonly string[];
export declare const PERMISSION_KEYS: readonly string[];
export declare function sessionFor(root?: boolean): { permissions: string[]; [key: string]: unknown };
