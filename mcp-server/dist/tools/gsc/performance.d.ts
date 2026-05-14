/**
 * GSC Performance — 3 tools.
 * gsc_performance_query, gsc_performance_export, gsc_performance_chart_screenshot
 */
import { z } from 'zod';
export declare const gscPerformanceQuerySchema: {
    searchType: z.ZodOptional<z.ZodEnum<["web", "image", "video", "news", "discover", "googleNews"]>>;
    dateRange: z.ZodOptional<z.ZodEnum<["24h", "7d", "28d", "3m", "6m", "12m", "16m", "custom"]>>;
    customStart: z.ZodOptional<z.ZodString>;
    customEnd: z.ZodOptional<z.ZodString>;
    dimension: z.ZodOptional<z.ZodEnum<["query", "page", "country", "device", "searchAppearance", "date"]>>;
    filters: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["query", "page", "country", "device"]>;
        op: z.ZodOptional<z.ZodEnum<["contains", "notContains", "equals", "notEquals", "regex", "notRegex"]>>;
        value: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        value: string;
        type: "page" | "query" | "country" | "device";
        op?: "contains" | "notContains" | "equals" | "notEquals" | "regex" | "notRegex" | undefined;
    }, {
        value: string;
        type: "page" | "query" | "country" | "device";
        op?: "contains" | "notContains" | "equals" | "notEquals" | "regex" | "notRegex" | undefined;
    }>, "many">>;
    compare: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscPerformanceQueryDescription: string;
export declare function handleGscPerformanceQuery(args: {
    searchType?: string;
    dateRange?: string;
    customStart?: string;
    customEnd?: string;
    dimension?: string;
    filters?: Array<{
        type: string;
        op?: string;
        value: string;
    }>;
    compare?: boolean;
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
export declare const gscPerformanceExportSchema: {
    format: z.ZodEnum<["csv", "excel", "google_sheets"]>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscPerformanceExportDescription: string;
export declare function handleGscPerformanceExport(args: {
    format: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscPerformanceChartScreenshotSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscPerformanceChartScreenshotDescription = "Capture a screenshot scoped to the Performance chart panel only \u2014 useful for visual reports.";
export declare function handleGscPerformanceChartScreenshot(args: {
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=performance.d.ts.map