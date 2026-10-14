import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
export const questions = [
  { name: 'relevant', type: 'predicate', instructions: 'Is the supplied evidence about login?' },
  { name: 'category', type: 'choice', instructions: 'Classify the evidence.', choices: [{ value: 'code' }, { value: 'other' }] },
  { name: 'severity', type: 'score', instructions: 'Rate severity.', levels: [{ label: 'routine' }, { label: 'urgent' }] },
];
export function decision(body) {
  return { model: body.model, answers: body.questions.map(q => q.type === 'predicate' ? { name: q.name, type: q.type, probability: 0.9 } : q.type === 'choice' ? { name: q.name, type: q.type, choice: q.choices[0].value, confidence: 0.9, probabilities: q.choices.map((v,i) => ({ value: v.value, probability: i ? 0 : 1 })) } : { name: q.name, type: q.type, score: 0, confidence: 0.9, probabilities: q.levels.map((v,i) => ({ label: v.label, value: i, probability: i ? 0 : 1 })) }), usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}
export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'decisions-test-'));
  await writeFile(path.join(root, 'example.txt'), '로그인 실패\nsecond line\nthird line');
  return root;
}
export function pdfFixture(pageCount = 2) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({length:pageCount},(_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pageCount} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i=0;i<pageCount;i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);
    const content = i === 0 ? 'BT /F1 14 Tf 20 200 Td (Login error) Tj ET' : '0 0 1 rg 20 20 100 100 re f';
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let value='%PDF-1.4\n'; const offsets=[0];
  for (const [i,o] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value+=`${i+1} 0 obj\n${o}\nendobj\n`; }
  const xref=Buffer.byteLength(value);
  value+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
