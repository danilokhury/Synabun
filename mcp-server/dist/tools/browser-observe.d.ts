import { z } from 'zod';
export declare const browserSnapshotSchema: {
    selector: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserSnapshotDescription: string;
export declare function handleBrowserSnapshot(args: {
    selector?: string;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserContentSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserContentDescription = "Get the text content of the current page along with its URL and title. Returns the visible text from the page body (up to 50K characters). Use this when you need raw text rather than the structured accessibility tree.";
export declare function handleBrowserContent(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserScreenshotSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserScreenshotDescription = "Take a screenshot of the current page. Returns a base64-encoded JPEG image. Use sparingly \u2014 prefer browser_snapshot for most tasks as it is far more token-efficient.";
export declare function handleBrowserScreenshot(args: {
    sessionId?: string;
}): Promise<{
    content: ({
        type: "text";
        text: string;
        data?: undefined;
        mimeType?: undefined;
    } | {
        type: "image";
        data: string;
        mimeType: string;
        text?: undefined;
    })[];
}>;
export declare const browserExtractTweetsSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractTweetsDescription = "Extract all currently visible tweets as structured JSON (author, handle, text, time, url, replies, reposts, likes, views). Much faster than browser_snapshot for data harvesting \u2014 use this in scraping/loop flows instead of reading the ARIA tree. Navigate to x.com/search?q=%23hashtag&f=live first for latest-first hashtag results.";
export declare function handleBrowserExtractTweets(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractFbPostsSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractFbPostsDescription: string;
export declare function handleBrowserExtractFbPosts(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractTiktokVideosSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractTiktokVideosDescription: string;
export declare function handleBrowserExtractTiktokVideos(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractTiktokSearchSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractTiktokSearchDescription: string;
export declare function handleBrowserExtractTiktokSearch(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractTiktokStudioSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractTiktokStudioDescription: string;
export declare function handleBrowserExtractTiktokStudio(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractTiktokProfileSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractTiktokProfileDescription: string;
export declare function handleBrowserExtractTiktokProfile(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractWaChatsSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractWaChatsDescription: string;
export declare function handleBrowserExtractWaChats(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractWaMessagesSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractWaMessagesDescription: string;
export declare function handleBrowserExtractWaMessages(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=browser-observe.d.ts.map