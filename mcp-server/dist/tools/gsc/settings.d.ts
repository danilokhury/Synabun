/**
 * GSC Settings + meta tools.
 * Tools: gsc_settings, gsc_crawl_stats, gsc_users, gsc_associations,
 *        gsc_disavow, gsc_shopping, gsc_extract_table, gsc_screenshot
 */
import { z } from 'zod';
export declare const gscSettingsSchema: {
    action: z.ZodOptional<z.ZodEnum<["get", "set_address", "change_address"]>>;
    newProperty: z.ZodOptional<z.ZodString>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscSettingsDescription = "Read or modify property settings \u2014 ownership/verification, users, address. action=get returns the settings page summary; action=set_address/change_address mutate.";
export declare function handleGscSettings(args: {
    action?: string;
    newProperty?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscCrawlStatsSchema: {
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscCrawlStatsDescription = "Read Crawl Stats \u2014 totals (requests, download size, response time) and breakdowns by host status, response code, file type, Googlebot type.";
export declare function handleGscCrawlStats(args: {
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscUsersSchema: {
    action: z.ZodEnum<["list", "add", "remove", "change_role"]>;
    email: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodEnum<["owner", "full", "restricted"]>>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscUsersDescription = "Manage property users. list returns email + role. add invites a user (mutating). remove revokes (mutating). change_role updates permissions (mutating).";
export declare function handleGscUsers(args: {
    action: string;
    email?: string;
    role?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscAssociationsSchema: {
    action: z.ZodEnum<["list", "add", "remove"]>;
    service: z.ZodOptional<z.ZodEnum<["google_analytics", "merchant_center", "google_ads", "play_store", "youtube", "actions_on_google", "chrome_web_store"]>>;
    identifier: z.ZodOptional<z.ZodString>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscAssociationsDescription = "Manage Associations (Analytics / Merchant / Ads / Play / YouTube / Actions / Chrome Web Store). list returns existing associations; add/remove mutate.";
export declare function handleGscAssociations(args: {
    action: string;
    service?: string;
    identifier?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscDisavowSchema: {
    action: z.ZodEnum<["download", "upload", "delete"]>;
    filePath: z.ZodOptional<z.ZodString>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscDisavowDescription = "[mutating for upload/delete \u2014 affects how Google trusts links to your site] Manage the Disavow Links file. download exports current; upload replaces (use sparingly).";
export declare function handleGscDisavow(args: {
    action: string;
    filePath?: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscShoppingSchema: {
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscShoppingDescription = "Read Shopping/Merchant Listings report \u2014 counts and per-issue example URLs.";
export declare function handleGscShopping(args: {
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscExtractTableSchema: {
    selector: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscExtractTableDescription = "Generic GSC grid \u2192 JSON extractor. Useful when no specific gsc_*_report tool covers a panel.";
export declare function handleGscExtractTable(args: {
    selector?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscScreenshotSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscScreenshotDescription = "Capture a full-page screenshot of the active GSC tab. Saved via SynaBun image staging.";
export declare function handleGscScreenshot(args: {
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=settings.d.ts.map