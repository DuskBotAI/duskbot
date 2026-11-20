export declare const LABEL: RegExp;
export declare const DOWN: number[];
export declare const ROUTE_TIMEOUT_MS: number;
export declare function routeServices(env: { ROUTE_URL: string; EDGE_TOKEN: string }): Array<{ origin: string; token: string }>;
export declare function lookupRoute(label: string, env: { ROUTE_URL: string; EDGE_TOKEN: string }): Promise<{ upstream: string; awake: boolean; wakeable: boolean } | { gone: true } | null>;
export declare function askWake(label: string, reason: "webhook" | "client", env: { ROUTE_URL: string; EDGE_TOKEN: string }): Promise<number>;
export declare function upstreamRequest(upstream: string, host: string, hook: { method: string; path: string; headers: HeadersInit; body?: BodyInit | null }): Request;
