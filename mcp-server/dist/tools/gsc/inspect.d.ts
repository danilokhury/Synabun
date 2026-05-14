/**
 * GSC URL Inspection — 4 tools.
 * gsc_inspect_url, gsc_inspect_test_live, gsc_inspect_request_indexing, gsc_inspect_view_crawled
 */
import { z } from 'zod';
export declare const gscInspectUrlSchema: {
    url: z.ZodString;
    property: z.ZodOptional<z.ZodString>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscInspectUrlDescription: string;
export declare function handleGscInspectUrl(args: {
    url: string;
    property?: string;
    timeoutMs?: number;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscInspectTestLiveSchema: {
    url: z.ZodOptional<z.ZodString>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscInspectTestLiveDescription: string;
export declare function handleGscInspectTestLive(args: {
    url?: string;
    timeoutMs?: number;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscInspectRequestIndexingSchema: {
    url: z.ZodOptional<z.ZodString>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscInspectRequestIndexingDescription: string;
export declare function handleGscInspectRequestIndexing(args: {
    url?: string;
    timeoutMs?: number;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscInspectViewCrawledSchema: {
    view: z.ZodEnum<["html", "screenshot", "http_response", "more_info"]>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscInspectViewCrawledDescription: string;
export declare function handleGscInspectViewCrawled(args: {
    view: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=inspect.d.ts.map