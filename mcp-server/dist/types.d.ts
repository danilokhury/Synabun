export interface MemoryPayload {
    content: string;
    category: string;
    subcategory?: string;
    project: string;
    tags: string[];
    importance: number;
    source: MemorySource;
    created_at: string;
    updated_at: string;
    accessed_at: string;
    access_count: number;
    related_files?: string[];
    related_memory_ids?: string[];
    file_checksums?: Record<string, string>;
    trashed_at?: string | null;
    source_session_chunks?: Array<{
        session_id: string;
        chunk_id: string;
    }>;
}
export type MemorySource = 'user-told' | 'self-discovered' | 'migration' | 'auto-saved';
export interface MemorySearchResult {
    id: string;
    score: number;
    payload: MemoryPayload;
}
export interface MemoryStats {
    total: number;
    by_category: Record<string, number>;
    by_project: Record<string, number>;
    oldest?: string;
    newest?: string;
}
export interface SessionChunkPayload {
    content: string;
    summary: string;
    session_id: string;
    project: string;
    git_branch: string | null;
    cwd: string | null;
    chunk_index: number;
    start_timestamp: string;
    end_timestamp: string;
    tools_used: string[];
    files_modified: string[];
    files_read: string[];
    user_messages: string[];
    turn_count: number;
    related_memory_ids: string[];
    dedup_memory_id: string | null;
    indexed_at: string;
}
export interface SessionIndexEntry {
    session_id: string;
    file_path: string;
    file_size: number;
    file_mtime: string;
    chunk_count: number;
    chunk_ids: string[];
    indexed_at: string;
    project: string;
    status: 'complete' | 'partial';
    last_line_indexed: number;
}
export interface SessionIndexState {
    version: number;
    sessions: Record<string, SessionIndexEntry>;
    last_run?: {
        started_at: string;
        completed_at: string;
        total_sessions: number;
        total_chunks: number;
        errors: number;
    };
}
//# sourceMappingURL=types.d.ts.map