#!/usr/bin/env node
import { installEmbeddingModel, closeEmbeddings } from '../services/local-embeddings.js';
try {
  console.log('Installing local MiniLM model files. No memory text is sent.');
  await installEmbeddingModel();
  console.log('Local model ready. Normal memory operations run offline.');
} catch (error) {
  console.error((error as Error).message); process.exitCode=1;
} finally {await closeEmbeddings();}
