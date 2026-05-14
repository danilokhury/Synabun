/**
 * GSC Experience + Enhancements + Links.
 * Tools: gsc_cwv_report, gsc_https_report, gsc_security_issues,
 *        gsc_manual_actions, gsc_enhancements, gsc_links_report, gsc_links_export
 */
import { z } from 'zod';
export declare const gscCwvReportSchema: {
    device: z.ZodEnum<["mobile", "desktop"]>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscCwvReportDescription = "Read Core Web Vitals report for mobile or desktop. Returns counts of poor / needs-improvement / good URLs and per-issue URL group examples.";
export declare function handleGscCwvReport(args: {
    device: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscHttpsReportSchema: {
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscHttpsReportDescription = "Read the HTTPS report \u2014 counts of HTTPS vs non-HTTPS URLs and reasons for non-HTTPS URLs with examples.";
export declare function handleGscHttpsReport(args: {
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscSecurityIssuesSchema: {
    action: z.ZodOptional<z.ZodEnum<["list", "request_review"]>>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscSecurityIssuesDescription = "Read Security Issues. action=list returns active + history. action=request_review clicks \"Request review\" (mutating, requires fixed issues).";
export declare function handleGscSecurityIssues(args: {
    action?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscManualActionsSchema: {
    action: z.ZodOptional<z.ZodEnum<["list", "reconsideration"]>>;
    body: z.ZodOptional<z.ZodString>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscManualActionsDescription = "Read Manual Actions. action=list returns penalties (or \"No issues detected\"). action=reconsideration submits a reconsideration request with `body` (mutating).";
export declare function handleGscManualActions(args: {
    action?: string;
    body?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscEnhancementsSchema: {
    report: z.ZodEnum<[string, ...string[]]>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscEnhancementsDescription: string;
export declare function handleGscEnhancements(args: {
    report: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscLinksReportSchema: {
    section: z.ZodEnum<["top_linked_external", "top_linking_sites", "top_linking_text", "top_linked_internal"]>;
    limit: z.ZodOptional<z.ZodNumber>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscLinksReportDescription = "Read a Links report section. top_linked_external / top_linking_sites / top_linking_text / top_linked_internal. Returns full table.";
export declare function handleGscLinksReport(args: {
    section: string;
    limit?: number;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscLinksExportSchema: {
    scope: z.ZodEnum<["external", "internal", "sample_external", "sample_internal"]>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscLinksExportDescription = "Trigger Links report Export menu. Browser handles file download.";
export declare function handleGscLinksExport(args: {
    scope: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=experience.d.ts.map