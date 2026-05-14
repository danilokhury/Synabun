/**
 * GSC Indexing reports — pages, videos, sitemaps, removals.
 * Tools: gsc_pages_report, gsc_pages_validate_fix, gsc_videos_report,
 *        gsc_sitemap, gsc_removals, gsc_removals_cancel
 */
import { z } from 'zod';
export declare const gscPagesReportSchema: {
    reason: z.ZodOptional<z.ZodString>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscPagesReportDescription: string;
export declare function handleGscPagesReport(args: {
    reason?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscPagesValidateFixSchema: {
    reason: z.ZodString;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscPagesValidateFixDescription = "[mutating \u2014 starts a Google validation cycle] Open a Pages-report reason bucket and click \"Validate fix\" so Google re-checks the URLs. Returns confirmation status.";
export declare function handleGscPagesValidateFix(args: {
    reason: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscVideosReportSchema: {
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscVideosReportDescription = "Read the Video indexing report \u2014 same shape as gsc_pages_report but for video pages.";
export declare function handleGscVideosReport(args: {
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscSitemapSchema: {
    action: z.ZodEnum<["list", "submit", "delete", "view_errors"]>;
    url: z.ZodOptional<z.ZodString>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscSitemapDescription: string;
export declare function handleGscSitemap(args: {
    action: string;
    url?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscRemovalsSchema: {
    action: z.ZodEnum<["list_temporary", "list_outdated", "list_safesearch", "new"]>;
    removalType: z.ZodOptional<z.ZodEnum<["temporary", "outdated_content", "safe_search"]>>;
    target: z.ZodOptional<z.ZodString>;
    scope: z.ZodOptional<z.ZodEnum<["url", "prefix"]>>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscRemovalsDescription: string;
export declare function handleGscRemovals(args: {
    action: string;
    removalType?: string;
    target?: string;
    scope?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscRemovalsCancelSchema: {
    url: z.ZodString;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscRemovalsCancelDescription = "[mutating] Cancel a pending temporary removal request. URL must match the listed entry exactly.";
export declare function handleGscRemovalsCancel(args: {
    url: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=indexing.d.ts.map