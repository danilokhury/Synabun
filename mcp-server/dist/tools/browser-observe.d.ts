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
    format: z.ZodDefault<z.ZodOptional<z.ZodEnum<["text", "markdown"]>>>;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserContentDescription = "Get the content of the current page. Set format=\"markdown\" for clean markdown with structure preserved (headings, links, lists) \u2014 nav/header/footer/ads stripped automatically. Default format=\"text\" returns raw visible text. Markdown is preferred for LLM consumption \u2014 up to 80% more token-efficient than raw HTML.";
export declare function handleBrowserContent(args: {
    format?: string;
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
    } | {
        type: "image";
        data: string;
        mimeType: string;
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
export declare const browserExtractIgFeedSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractIgFeedDescription: string;
export declare function handleBrowserExtractIgFeed(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractIgProfileSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractIgProfileDescription: string;
export declare function handleBrowserExtractIgProfile(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractIgPostSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractIgPostDescription: string;
export declare function handleBrowserExtractIgPost(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractIgReelsSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractIgReelsDescription: string;
export declare function handleBrowserExtractIgReels(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractIgSearchSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractIgSearchDescription: string;
export declare function handleBrowserExtractIgSearch(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractLiFeedSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractLiFeedDescription: string;
export declare function handleBrowserExtractLiFeed(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractLiProfileSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractLiProfileDescription: string;
export declare function handleBrowserExtractLiProfile(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractLiPostSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractLiPostDescription: string;
export declare function handleBrowserExtractLiPost(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractLiNotificationsSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractLiNotificationsDescription: string;
export declare function handleBrowserExtractLiNotifications(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractLiMessagesSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractLiMessagesDescription: string;
export declare function handleBrowserExtractLiMessages(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractLiSearchPeopleSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractLiSearchPeopleDescription: string;
export declare function handleBrowserExtractLiSearchPeople(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserExtractLiNetworkSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserExtractLiNetworkDescription: string;
export declare function handleBrowserExtractLiNetwork(args: {
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=browser-observe.d.ts.map