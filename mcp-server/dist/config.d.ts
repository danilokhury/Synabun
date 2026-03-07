export declare const config: {
    readonly dataDir: string;
    readonly sqlite: {
        readonly dbPath: string;
    };
    readonly embedding: {
        readonly model: "Xenova/all-MiniLM-L6-v2";
        readonly dimensions: 384;
    };
};
export declare function getEnvPath(): string;
export declare function detectProject(cwd?: string): string;
//# sourceMappingURL=config.d.ts.map