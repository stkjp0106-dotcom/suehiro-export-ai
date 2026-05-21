import test from 'node:test';
import assert from 'node:assert/strict';
import { selectKnowledgeFiles } from '../src/knowledge.mjs';

test('selectKnowledgeFiles picks Hong Kong gyutan and quotation context for price questions', () => {
  const files = selectKnowledgeFiles('\u6628\u65e5\u6765\u305f\u4f0a\u85e4\u30cf\u30e0\u304b\u3089\u306e\u58f2\u8cb7\u5951\u7d04\u66f8\u3002\u9999\u6e2f\u725b\u30bf\u30f3\u306e\u4fa1\u683c\u8868\u3069\u3053\uff1f');

  assert(files.some((file) => file.endsWith('00_EXPORT_MASTER/00_READ_ME_FIRST.md')));
  assert(files.some((file) => file.endsWith('01_PRODUCTS/Gyutan.md')));
  assert(files.some((file) => file.endsWith('02_COUNTRIES/Hong_Kong.md')));
  assert(files.some((file) => file.endsWith('06_CASE_STUDY/HongKong_Gyutan.md')));
  assert(files.some((file) => file.endsWith('05_SALES_TEMPLATE/03_QUOTATION_SEND.md')));
});
