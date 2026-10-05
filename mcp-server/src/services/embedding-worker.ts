import type { FeatureExtractionPipeline } from '@huggingface/transformers';

let extractor: FeatureExtractionPipeline | null = null;
async function getExtractor(install = false): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  const { pipeline } = await import('@huggingface/transformers');
  extractor = await (pipeline as any)('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'fp32', local_files_only: !install,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  return extractor!;
}

process.on('message', async ({ id, op, text }: {id:number;op:string;text:string}) => {
  try {
    const ext = await getExtractor(op === 'install');
    let value: unknown;
    if (op === 'embed') {
      const output = await ext(text, { pooling: 'mean', normalize: true });
      value = Array.from(output.data as Float32Array);
    } else if (op === 'split') {
      // Preserve literal source text; tokenization only checks the window size.
      const tokenizer = ext.tokenizer as any;
      const max = Math.min(256, Number(tokenizer.model_max_length) || 256);
      const chars = Array.from(text as string);
      const parts: string[] = [];
      let start = 0;
      while (start < chars.length) {
        let end = Math.min(start + 900, chars.length);
        while (end > start + 1) {
          const tokens = await tokenizer(chars.slice(start, end).join(''), { truncation: false });
          if (tokens.input_ids.data.length <= max) break;
          end = start + Math.max(1, Math.floor((end - start) * 0.7));
        }
        parts.push(chars.slice(start, end).join(''));
        start = end;
      }
      value = parts;
    } else value = true;
    process.send!({ id, value });
  } catch (error) { process.send!({ id, error: (error as Error).message }); }
});

// The native addon leaves process-static threads alive even after dispose.
// This child has no durable writes; abrupt exit cannot lose stored memories.
process.on('disconnect',()=>{process.kill(process.pid,'SIGKILL');});
