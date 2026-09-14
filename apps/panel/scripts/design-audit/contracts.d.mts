export interface RouteContract { expectedPath?: string | null; heading: string; marker: string; state: string; entitySelector?: string; }
export declare const ROUTE_CONTRACTS: Record<string, RouteContract>;
export declare function contractFor(route: string): RouteContract | undefined;
