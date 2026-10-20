// Slice 2 live check: drives a REAL stack (real Postgres + MinIO + worker + Docling) through the files
// pipeline over HTTP and prints what happened. Not part of the test suite.
//
//   LIVE_API=http://127.0.0.1:8800 LIVE_PNG=/path/to/printed-page.png \
//     node --import tsx docs/live-checks/slice-2-live-check.ts
//
// Output is a list of lines "PASS|FAIL|INFO <what>"; the process exits 1 when any check fails.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { docx, xlsx } from '../../e2e/fixtures.js';

const API = process.env.LIVE_API ?? 'http://127.0.0.1:8800';
const PNG_PATH = process.env.LIVE_PNG;
const PNG_PHRASE = process.env.LIVE_PNG_PHRASE ?? 'Quarterly safety inspection checklist';
const suffix = Date.now().toString(36);

/** A PDF as a word processor or browser makes it (embedded fonts, a real text layer): one string per page. */
async function realPdf(name: string, _label: string, ...pages: string[]) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const html = pages
      .map((t, i) => `<section style="page-break-after:${i === pages.length - 1 ? 'auto' : 'always'}"><h1>Section ${i + 1}</h1><p style="font-size:18px">${t} ${_label}</p></section>`)
      .join('');
    await page.setContent(`<html><body style="font-family:Helvetica,Arial,sans-serif">${html}</body></html>`);
    const buffer = Buffer.from(await page.pdf({ format: 'A4' }));
    return { name, mimeType: 'application/pdf', buffer };
  } finally {
    await browser.close();
  }
}
let failures = 0;

const say = (kind: 'PASS' | 'FAIL' | 'INFO', text: string) => {
  if (kind === 'FAIL') failures += 1;
  console.log(`${kind} ${text}`);
};
const check = (ok: boolean, text: string, detail?: unknown) =>
  say(ok ? 'PASS' : 'FAIL', ok ? text : `${text} — got ${JSON.stringify(detail)}`);

interface Account {
  token: string;
  id: string;
  tenantId?: string;
}

async function http(method: string, path: string, o: { account?: Account; headers?: Record<string, string>; json?: unknown; form?: FormData; token?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.account) {
    headers.authorization = `Bearer ${o.account.token}`;
    if (o.account.tenantId) headers['x-tenant-id'] = o.account.tenantId;
  }
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
const ok = async (method: string, path: string, o: Parameters<typeof http>[2] = {}) => {
  const r = await http(method, path, o);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};

async function signUp(name: string): Promise<Account> {
  const r = await ok('POST', '/api/v1/auth/sign-up', { json: { email: `${name.toLowerCase().replace(/\W+/g, '-')}-${suffix}@example.test`, name, password: 'correct-horse-battery' } });
  return { token: r.session.token, id: r.user.id };
}

async function workspace(owner: Account, label: string): Promise<{ account: Account; tenantId: string }> {
  const t = await ok('POST', '/api/v1/tenants', { account: owner, json: { name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` } });
  return { account: { ...owner, tenantId: t.tenant.id }, tenantId: t.tenant.id };
}

const space = (account: Account, name: string, slug: string, extra: Record<string, unknown> = {}) =>
  ok('POST', '/api/v1/spaces', { account, json: { name, slug, review_required: false, ...extra } });

function form(file: { name: string; mimeType: string; buffer: Buffer }, fields: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  f.set('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.name);
  return f;
}

async function waitBadge(account: Account, id: string, until: RegExp, label: string, timeoutMs = 600_000) {
  const started = Date.now();
  let badge = '';
  while (Date.now() - started < timeoutMs) {
    badge = (await ok('GET', `/api/v1/files/${id}`, { account })).badge;
    if (until.test(badge)) {
      say('INFO', `${label}: "${badge}" after ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return badge;
    }
    if (/failed|^Stored/i.test(badge) && !until.test(badge)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  say('FAIL', `${label}: stopped at "${badge}"`);
  return badge;
}

const search = async (account: Account, query: string) => (await ok('POST', '/api/v1/search', { account, json: { query, limit: 10 } })).passages as any[];

async function main() {
  // Is the stack up?
  for (let i = 0; i < 60; i++) {
    const r = await http('GET', '/api/v1/me').catch(() => null);
    if (r && r.status === 401) break;
    if (i === 59) throw new Error(`the api at ${API} does not answer`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const owner = await signUp('Olive Owner');
  const A = await workspace(owner, 'Alpha');
  const docs = await space(A.account, 'Docs', 'docs');
  const reviewer = await signUp('Rita Reviewer');
  const invite = await ok('POST', '/api/v1/invitations', { account: A.account, json: { email: `rita-reviewer-${suffix}@example.test`, role: 'member' } });
  await ok('POST', '/api/v1/invitations/accept', { account: reviewer, json: { token: invite.acceptToken } });
  const rita: Account = { ...reviewer, tenantId: A.tenantId };

  // 1. A two-page PDF: one sentence a page.
  const word1 = `heron${suffix}`;
  const word2 = `marmot${suffix}`;
  const pdf = await realPdf('Field notes.pdf', suffix, `The ${word1} migrates in autumn.`, `The ${word2} hibernates all winter.`);
  const up = await ok('POST', '/api/v1/files', { account: A.account, form: form(pdf, { space_id: docs.id }) });
  const pdfId = up.document.id as string;
  check(up.unchanged === false, 'the PDF upload is accepted');
  await waitBadge(A.account, pdfId, /^Indexed/, 'PDF 2 pages');
  const hits = await search(A.account, word2);
  const hit = hits.find((p) => p.documentId === pdfId);
  check(Boolean(hit) && hit.documentKind === 'file', 'search finds the PDF', hits.map((p) => [p.documentKind, p.pageFrom]));
  check(hit?.pageFrom === 2, 'the passage from page 2 cites page 2', hit?.pageFrom);
  const answer = await ok('POST', '/api/v1/ask', { account: A.account, json: { question: `When does the ${word1} migrate?` } });
  const cited = (answer.citations as any[]).find((c) => c.documentId === pdfId);
  check(Boolean(cited), 'Ask cites the PDF', answer.citations?.map((c: any) => c.citeAs));
  check(cited?.pageFrom === 1, 'the citation carries page 1', cited?.pageFrom);
  say('INFO', `Ask answered: ${String(answer.answer).slice(0, 200)}`);

  // 2. A two-sheet workbook.
  const cell = `lupin${suffix}`;
  const book = xlsx('Plants.xlsx', suffix, [
    { name: 'Wild', rows: [['Plant', 'Height'], ['Fern', 30]] },
    { name: 'Garden', rows: [['Plant', 'Height'], [cell, 80]] },
  ]);
  const bookId = (await ok('POST', '/api/v1/files', { account: A.account, form: form(book, { space_id: docs.id }) })).document.id as string;
  await waitBadge(A.account, bookId, /^Indexed/, 'XLSX 2 sheets');
  const bookHit = (await search(A.account, cell)).find((p) => p.documentId === bookId);
  check(Boolean(bookHit), 'search finds the workbook cell', bookHit);
  check(bookHit?.pageFrom === 2, 'the cell on the second sheet cites sheet 2', bookHit?.pageFrom);

  // 3. A word-processor file.
  const wordWord = `badger${suffix}`;
  const word = docx('Memo.docx', suffix, 'Memo', `The ${wordWord} digs a new sett every spring.`);
  const wordId = (await ok('POST', '/api/v1/files', { account: A.account, form: form(word, { space_id: docs.id }) })).document.id as string;
  await waitBadge(A.account, wordId, /^Indexed/, 'DOCX');
  check((await search(A.account, wordWord)).some((p) => p.documentId === wordId), 'search finds the DOCX text');

  // 4. A printed page, as a picture (OCR).
  if (PNG_PATH) {
    const png = { name: 'Printed page.png', mimeType: 'image/png', buffer: readFileSync(PNG_PATH) };
    const pngId = (await ok('POST', '/api/v1/files', { account: A.account, form: form(png, { space_id: docs.id }) })).document.id as string;
    await waitBadge(A.account, pngId, /^(Indexed|Stored)/, 'PNG (OCR)');
    const versionId = (await ok('GET', `/api/v1/files/${pngId}`, { account: A.account })).latestVersion.id as string;
    const chunks = await ok('GET', `/api/v1/versions/${versionId}/chunks`, { account: A.account });
    const text = (chunks.sections as any[]).map((s) => [...s.headingPath, s.text].join(' ')).join(' ');
    say('INFO', `OCR text: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    check(chunks.ocrUsed === true, 'the picture was read with OCR', chunks.ocrUsed);
    check(text.toLowerCase().includes(PNG_PHRASE.toLowerCase().split(' ')[0]!), `the OCR text contains "${PNG_PHRASE.split(' ')[0]}"`);
    check((await search(A.account, PNG_PHRASE)).some((p) => p.documentId === pngId), 'search finds the printed page');
  } else say('INFO', 'No LIVE_PNG given: the OCR check was not run');

  // 5. A replacement waits for review while the old version keeps answering.
  const reviewed = await space(A.account, 'Reviewed', 'reviewed', { review_required: true });
  await ok('POST', `/api/v1/spaces/${reviewed.id}/grants`, { account: A.account, json: { principal_type: 'user', principal_id: reviewer.id, role: 'reviewer' } });
  const oldWord = `walrus${suffix}`;
  const newWord = `narwhal${suffix}`;
  const v1 = await ok('POST', '/api/v1/files', { account: A.account, form: form(await realPdf('Policy.pdf', `${suffix}-1`, `The ${oldWord} policy applies.`), { space_id: reviewed.id }) });
  const policyId = v1.document.id as string;
  await waitBadge(A.account, policyId, /awaiting approval/, 'policy v1 waits for review');
  const queue1 = await ok('GET', '/api/v1/reviews', { account: rita });
  for (const item of queue1) await ok('POST', `/api/v1/versions/${item.version.id}/approve`, { account: rita, json: {} });
  await waitBadge(A.account, policyId, /^Indexed · v1$/, 'policy v1 approved');
  await ok('POST', `/api/v1/files/${policyId}/versions`, { account: A.account, form: form(await realPdf('Policy.pdf', `${suffix}-2`, `The ${newWord} policy replaces it.`)) });
  await waitBadge(A.account, policyId, /v2 awaiting approval/, 'policy v2 waits for review');
  const during = await search(A.account, oldWord);
  check(during.some((p) => p.documentId === policyId && p.versionNumber === 1 && p.text.includes(oldWord)), 'while v2 waits, v1 still answers search');
  check(!(await search(A.account, newWord)).some((p) => p.text.includes(newWord)), 'while v2 waits, its text is not searchable');
  const queue2 = await ok('GET', '/api/v1/reviews', { account: rita });
  for (const item of queue2) await ok('POST', `/api/v1/versions/${item.version.id}/approve`, { account: rita, json: {} });
  await waitBadge(A.account, policyId, /^Indexed · v2$/, 'policy v2 approved');
  check((await search(A.account, newWord)).some((p) => p.documentId === policyId && p.text.includes(newWord)), 'after approval v2 answers search');

  // 6. A source: PUT then DELETE.
  const src = await ok('POST', '/api/v1/sources', { account: A.account, json: { name: 'Live sync', target_space_id: docs.id } });
  await ok('PATCH', `/api/v1/sources/${src.id}`, { account: A.account, json: { trusted: true } });
  const tok = (await ok('POST', `/api/v1/sources/${src.id}/tokens`, { account: A.account, json: { name: 'live' } })).token as string;
  const srcWord = `ibex${suffix}`;
  const put = await http('PUT', '/api/v1/source/files/live/ibex', { token: tok, form: form(await realPdf('Ibex.pdf', suffix, `The ${srcWord} climbs steep rock.`)) });
  check(put.status === 201, 'a script PUT creates the file', put.status);
  const srcId = put.body.document.id as string;
  await waitBadge(A.account, srcId, /^Indexed/, 'source file (trusted: no review)');
  check((await search(A.account, srcWord)).some((p) => p.documentId === srcId), 'the source file is searchable');
  const del = await http('DELETE', '/api/v1/source/files/live/ibex', { token: tok });
  check(del.status === 200, 'a script DELETE answers 200', del.status);
  check(!(await search(A.account, srcWord)).some((p) => p.documentId === srcId && p.text.includes(srcWord)), 'the removed file left search at once');
  check((await ok('GET', `/api/v1/files/${srcId}`, { account: A.account })).badge === 'Removed at source', 'its badge says "Removed at source"');

  // 7. Another workspace sees nothing of it.
  const other = await signUp('Bob Other');
  const B = await workspace(other, 'Beta');
  const inB = await http('GET', `/api/v1/files/${pdfId}`, { account: B.account });
  check(inB.status === 404, 'a file of workspace Alpha is a 404 in Beta', inB.status);
  const bytesB = await http('GET', `/api/v1/versions/${(await ok('GET', `/api/v1/files/${pdfId}`, { account: A.account })).latestVersion.id}/file`, { account: B.account });
  check(bytesB.status === 404, 'its bytes are a 404 in Beta', bytesB.status);
  check((await search(B.account, word2)).length === 0, 'search in Beta returns nothing of Alpha');
  const asSource = await http('GET', '/api/v1/files', { token: tok });
  check(asSource.status >= 400, 'a source token opens no ordinary route', asSource.status);

  say('INFO', JSON.stringify({ tenantA: A.tenantId, tenantB: B.tenantId, pdfId, bookId, wordId, policyId, srcId }));
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL', err instanceof Error ? err.message : err);
  process.exit(1);
});
