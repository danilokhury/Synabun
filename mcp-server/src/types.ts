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
}

export type MemorySource =
  | 'user-told'
  | 'self-discovered'
  | 'migration'
  | 'auto-saved';

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
