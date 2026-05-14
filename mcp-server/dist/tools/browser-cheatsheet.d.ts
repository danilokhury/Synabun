import { z } from 'zod';
declare const PLATFORMS: readonly ["twitter", "facebook", "tiktok", "whatsapp", "instagram", "linkedin"];
declare const ACTIONS: readonly ["click", "type", "fill", "scroll", "snapshot", "extract"];
type Platform = typeof PLATFORMS[number];
type Action = typeof ACTIONS[number];
export declare const browserCheatsheetSchema: {
    platform: z.ZodEnum<["twitter", "facebook", "tiktok", "whatsapp", "instagram", "linkedin"]>;
    action: z.ZodOptional<z.ZodEnum<["click", "type", "fill", "scroll", "snapshot", "extract"]>>;
};
export declare const browserCheatsheetDescription = "Look up stable selectors and flow notes for a social platform (twitter, facebook, tiktok, whatsapp, instagram, linkedin). Call this before automating a platform the first time in a session \u2014 then reuse the returned selectors for browser_click / browser_type / browser_fill / browser_scroll / browser_snapshot.";
export declare function handleBrowserCheatsheet(args: {
    platform: Platform;
    action?: Action;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export {};
//# sourceMappingURL=browser-cheatsheet.d.ts.map