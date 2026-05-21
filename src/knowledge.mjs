import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_FILES = ['00_EXPORT_MASTER/00_READ_ME_FIRST.md'];

const KEYWORD_FILES = [
  {
    keywords: ['\u725b\u30bf\u30f3', '\u304e\u3085\u3046\u305f\u3093', '\u30bf\u30f3', 'gyutan', 'tongue'],
    files: ['01_PRODUCTS/Gyutan.md']
  },
  {
    keywords: ['\u9999\u6e2f', 'hong kong', 'hk'],
    files: ['02_COUNTRIES/Hong_Kong.md']
  },
  {
    keywords: ['\u4fa1\u683c', '\u5358\u4fa1', '\u898b\u7a4d', '\u58f2\u8cb7', '\u5951\u7d04', '\u78ba\u8a8d\u66f8', 'quotation', 'price'],
    files: ['05_SALES_TEMPLATE/03_QUOTATION_SEND.md']
  },
  {
    keywords: ['\u9999\u6e2f', '\u725b\u30bf\u30f3'],
    requireAll: true,
    files: ['06_CASE_STUDY/HongKong_Gyutan.md']
  },
  {
    keywords: ['hong kong', 'gyutan'],
    requireAll: true,
    files: ['06_CASE_STUDY/HongKong_Gyutan.md']
  }
];

export function selectKnowledgeFiles(userText) {
  const normalized = String(userText || '').toLowerCase();
  const selected = new Set(BASE_FILES);

  for (const rule of KEYWORD_FILES) {
    const matches = rule.requireAll
      ? rule.keywords.every((keyword) => normalized.includes(keyword.toLowerCase()))
      : rule.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));

    if (matches) {
      for (const file of rule.files) {
        selected.add(file);
      }
    }
  }

  return [...selected];
}

export function loadKnowledgeContext(userText, baseDir = process.cwd()) {
  const chunks = [];

  for (const file of selectKnowledgeFiles(userText)) {
    const path = join(baseDir, file);
    if (!existsSync(path)) {
      continue;
    }

    chunks.push(`--- ${file} ---\n${readFileSync(path, 'utf8').trim()}`);
  }

  return chunks.join('\n\n');
}
