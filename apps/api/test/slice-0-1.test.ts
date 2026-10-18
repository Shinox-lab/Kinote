import { test, describe, beforeEach, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import {
  db,
  withTenantTx,
  withUntenantedTx,
  spaces,
  jobs,
  enqueueJob,
  markJobOutcome,
} from '@living-wiki/db';
import { buildApiServer } from '../src/server.js';
import { objectStorage } from '../src/storage.js';
import { collabServer } from '../../collab/src/server.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { defaultEmbeddingProvider } from '@living-wiki/core';
import { formatApiError } from '../../web/src/App.js';

describe('Living Wiki — Slice 0 (Foundations) & Slice 1 (Live Pages)', () => {
  const app = buildApiServer();

  beforeEach(async () => {
    await (db as any).__resetForTests();
    collabServer.activeDocs.clear();
    defaultEmbeddingProvider.callCount = 0;
  });

  afterAll(async () => {
    // Tear down any leftover collab documents/sessions so the test process can exit.
    collabServer.activeDocs.clear();
  });

  test('Slice 0 Live Check: RLS zero-row guarantee when app.tenant_id is unset & strict cross-tenant 404 isolation', async () => {
    // 1. Create Tenant A and Tenant B via API
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: {
        name: 'Acme Robotics',
        slug: 'acme-robotics',
        owner_email: 'alice@acme.io',
        owner_name: 'Alice Owner',
      },
    });
    assert.equal(resA.statusCode, 201);
    const tenantAData = resA.json();
    const tenantA = tenantAData.tenant.id;
    const aliceId = tenantAData.owner.id;

    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: {
        name: 'Beta Bio',
        slug: 'beta-bio',
        owner_email: 'bob@betabio.io',
        owner_name: 'Bob Owner',
      },
    });
    assert.equal(resB.statusCode, 201);
    const tenantBData = resB.json();
    const tenantB = tenantBData.tenant.id;
    const bobId = tenantBData.owner.id;

    // Both tenants automatically get an Inbox system space
    assert.equal(tenantAData.inboxSpace.kind, 'inbox');
    assert.equal(tenantBData.inboxSpace.kind, 'inbox');

    // Create a normal space in Tenant A and Tenant B
    const spaceARes = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: {
        'x-tenant-id': tenantA,
        'x-principal-type': 'user',
        'x-principal-id': aliceId,
        'x-tenant-role': 'owner',
      },
      payload: { name: 'Engineering', slug: 'engineering', review_required: true },
    });
    assert.equal(spaceARes.statusCode, 201);
    const spaceA = spaceARes.json();

    const spaceBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: {
        'x-tenant-id': tenantB,
        'x-principal-type': 'user',
        'x-principal-id': bobId,
        'x-tenant-role': 'owner',
      },
      payload: { name: 'Clinical Trials', slug: 'clinical-trials', review_required: true },
    });
    assert.equal(spaceBRes.statusCode, 201);
    const spaceB = spaceBRes.json();

    // 2. Connect as living_wiki_app without app.tenant_id -> SELECT count(*) FROM spaces returns 0
    const untenantedCount = await withUntenantedTx(async (tx) => {
      const r = await tx.execute(sql`SELECT count(*) FROM spaces`);
      return Number(r.rows[0].count);
    });
    assert.equal(untenantedCount, 0, 'RLS must return 0 rows when app.tenant_id is unset');

    // 3. Querying spaceB inside withTenantTx(tenantA) returns 0 rows by SQL
    const crossSqlRows = await withTenantTx(tenantA, async (tx) => {
      return tx.select().from(spaces);
    });
    assert.equal(crossSqlRows.some((s: any) => s.id === spaceB.id), false);

    // 4. Tenant A requesting Tenant B's space via API returns 404 space_not_found, NEVER 403
    const crossApiRes = await app.inject({
      method: 'GET',
      url: `/api/v1/spaces/${spaceB.id}`,
      headers: {
        'x-tenant-id': tenantA,
        'x-principal-type': 'user',
        'x-principal-id': aliceId,
        'x-tenant-role': 'owner',
      },
    });
    assert.equal(crossApiRes.statusCode, 404);
    assert.equal(crossApiRes.json().error, 'space_not_found');

    // 5. Malformed UUID answers 404 space_not_found
    const malformedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/spaces/not-a-valid-uuid',
      headers: {
        'x-tenant-id': tenantA,
        'x-principal-type': 'user',
        'x-principal-id': aliceId,
        'x-tenant-role': 'owner',
      },
    });
    assert.equal(malformedRes.statusCode, 404);
    assert.equal(malformedRes.json().error, 'space_not_found');

    // 6. Object storage enforces per-tenant prefix
    const stored = await objectStorage.putObject(
      tenantA,
      'uploads/spec.pdf',
      Buffer.from('PDF-BYTES'),
      'application/pdf'
    );
    assert.equal(stored.objectKey.startsWith(`${tenantA}/`), true);
    await assert.rejects(
      () => objectStorage.getObject(tenantB, stored.objectKey),
      (err: any) => err.statusCode === 404 && err.error === 'document_not_found'
    );
  });

  test('Slice 0 Role Hierarchy, 404 vs 403 Boundary, Agent Role Cap & Dead-Letter Job Queue', async () => {
    const { tenant, owner } = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        payload: {
          name: 'Nova Labs',
          slug: 'nova-labs',
          owner_email: 'owner@nova.io',
          owner_name: 'Nova Owner',
        },
      })
    ).json();

    const space = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/spaces',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': owner.id,
          'x-tenant-role': 'owner',
        },
        payload: { name: 'Security', slug: 'security', review_required: true },
      })
    ).json();

    const memberUser = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/invitations',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': owner.id,
          'x-tenant-role': 'owner',
        },
        payload: { email: 'viewer@nova.io', name: 'Vera Viewer', role: 'member' },
      })
    ).json();

    // Unreadable space for member without grant -> 404 space_not_found (never 403)
    const beforeGrant = await app.inject({
      method: 'GET',
      url: `/api/v1/spaces/${space.id}`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': memberUser.id,
        'x-tenant-role': 'member',
      },
    });
    assert.equal(beforeGrant.statusCode, 404);
    assert.equal(beforeGrant.json().error, 'space_not_found');

    // Grant viewer role to Vera
    await app.inject({
      method: 'POST',
      url: `/api/v1/spaces/${space.id}/grants`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': owner.id,
        'x-tenant-role': 'owner',
      },
      payload: {
        principal_type: 'user',
        principal_id: memberUser.id,
        role: 'viewer',
      },
    });

    // Readable space, but viewer attempting admin settings update -> 403 forbidden
    const forbiddenPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/spaces/${space.id}`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': memberUser.id,
        'x-tenant-role': 'member',
      },
      payload: { quiet_seconds: 60 },
    });
    assert.equal(forbiddenPatch.statusCode, 403);
    assert.equal(forbiddenPatch.json().error, 'forbidden');
    assert.equal(
      formatApiError(forbiddenPatch.json().error),
      'You do not have permission to perform this action.'
    );

    // Agent cannot be granted reviewer or admin (Rule S4)
    const agentReviewerAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/spaces/${space.id}/grants`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': owner.id,
        'x-tenant-role': 'owner',
      },
      payload: {
        principal_type: 'agent',
        principal_id: '00000000-0000-0000-0000-000000000099',
        role: 'reviewer',
      },
    });
    assert.equal(agentReviewerAttempt.statusCode, 403);

    // Idempotent job queue deduplication and dead-letter transition
    await withTenantTx(tenant.id, async (tx) => {
      const j1 = await enqueueJob(tx, {
        tenantId: tenant.id,
        queue: 'test.queue',
        idempotencyKey: 'item-1',
        payload: { step: 1 },
        maxAttempts: 2,
      });
      const j2 = await enqueueJob(tx, {
        tenantId: tenant.id,
        queue: 'test.queue',
        idempotencyKey: 'item-1',
        payload: { step: 2 },
        maxAttempts: 2,
      });
      assert.equal(j1.id, j2.id, 'Idempotent key must update existing job row');

      const afterFail1 = await markJobOutcome(tx, tenant.id, j1.id, {
        ok: false,
        error: 'Temporary failure',
      });
      assert.equal(afterFail1?.status, 'queued');

      const afterFail2 = await markJobOutcome(tx, tenant.id, j1.id, {
        ok: false,
        error: 'Permanent failure',
      });
      assert.equal(afterFail2?.status, 'dead_letter');

      const allJobs = await tx.select().from(jobs);
      assert.equal(allJobs.length, 1);
    });
  });

  test('Slice 1 Live Check: Two people co-edit live via Hocuspocus; review space holds v2 until approved; search & Ask cite v2 only after approval', async () => {
    // 1. Setup Tenant, Space (review_required = true, allow_self_approval = false), Editor 1, Editor 2, and Reviewer
    const { tenant, owner: adminUser } = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        payload: {
          name: 'Helios Energy',
          slug: 'helios-energy',
          owner_email: 'admin@helios.io',
          owner_name: 'Hannah Admin',
        },
      })
    ).json();

    const space = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/spaces',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': adminUser.id,
          'x-tenant-role': 'owner',
        },
        payload: {
          name: 'Company Handbook',
          slug: 'handbook',
          review_required: true,
          quiet_seconds: 120,
          allow_self_approval: false,
        },
      })
    ).json();

    const editor1 = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/invitations',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': adminUser.id,
          'x-tenant-role': 'owner',
        },
        payload: { email: 'ed1@helios.io', name: 'Evan Editor', role: 'member' },
      })
    ).json();

    const editor2 = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/invitations',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': adminUser.id,
          'x-tenant-role': 'owner',
        },
        payload: { email: 'ed2@helios.io', name: 'Elena CoEditor', role: 'member' },
      })
    ).json();

    const reviewer = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/invitations',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': adminUser.id,
          'x-tenant-role': 'owner',
        },
        payload: { email: 'rev@helios.io', name: 'Rachel Reviewer', role: 'member' },
      })
    ).json();

    for (const [uid, role] of [
      [editor1.id, 'editor'],
      [editor2.id, 'editor'],
      [reviewer.id, 'reviewer'],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/spaces/${space.id}/grants`,
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': adminUser.id,
          'x-tenant-role': 'owner',
        },
        payload: { principal_type: 'user', principal_id: uid, role },
      });
    }

    // 2. Editor 1 creates the page and submits v1 ("Initial policy: 2 days remote per week")
    const createdPageRes = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': editor1.id,
        'x-tenant-role': 'member',
      },
      payload: {
        space_id: space.id,
        title: 'Remote Work Policy',
        slug: 'remote-work-policy',
        markdown: '## Eligibility\n\nInitial policy: 2 days remote per week for all full-time staff.',
      },
    });
    assert.equal(createdPageRes.statusCode, 201);
    const pageId = createdPageRes.json().document.id;

    const snap1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/snapshot`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': editor1.id,
        'x-tenant-role': 'member',
      },
    });
    assert.equal(snap1Res.statusCode, 201);
    const v1 = snap1Res.json();
    assert.equal(v1.number, 1);
    assert.equal(v1.status, 'pending_review');

    // Author attempting self-approval is blocked with 409 self_approval
    const selfApproveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${v1.id}/approve`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': editor1.id,
        'x-tenant-role': 'owner', // Even with admin capability, author cannot self-approve when allow_self_approval = false
      },
    });
    assert.equal(selfApproveRes.statusCode, 409);
    assert.equal(selfApproveRes.json().error, 'self_approval');

    // Reviewer approves v1 and worker indexes it
    const approveV1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${v1.id}/approve`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': reviewer.id,
        'x-tenant-role': 'member',
      },
      payload: { review_note: 'Approved initial policy' },
    });
    assert.equal(approveV1Res.statusCode, 200);
    await runPendingJobsForTenant(tenant.id);

    // Check badge is "Indexed · v1"
    const pageAfterV1 = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/pages/${pageId}`,
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': editor1.id,
          'x-tenant-role': 'member',
        },
      })
    ).json();
    assert.equal(pageAfterV1.badge, 'Indexed · v1');

    // 3. Editor 1 and Editor 2 connect simultaneously to Hocuspocus collab server and co-edit live
    const docName = `${tenant.id}:${pageId}`;
    const session1 = await collabServer.openSession({
      documentName: docName,
      token: `user:${editor1.id}:member`,
    });
    const session2 = await collabServer.openSession({
      documentName: docName,
      token: `user:${editor2.id}:member`,
    });

    // Editor 1 updates block-2
    await session1.transact(
      { source: 'human', actorId: editor1.id, changedBlockIds: ['block-2'] },
      (ydoc: any) => {
        ydoc.blocks = [
          { id: 'block-1', type: 'heading', level: 2, text: 'Eligibility', markdown: '## Eligibility' },
          {
            id: 'block-2',
            type: 'paragraph',
            text: 'Updated remote work policy: 4 days remote work from anywhere.',
            markdown: 'Updated remote work policy: 4 days remote work from anywhere.',
          },
        ];
      }
    );

    // Editor 2 adds a new section block-3 and block-4 in the same live Yjs document
    await session2.transact(
      { source: 'human', actorId: editor2.id, changedBlockIds: ['block-3', 'block-4'] },
      (ydoc: any) => {
        ydoc.blocks.push(
          { id: 'block-3', type: 'heading', level: 2, text: 'Equipment Stipend', markdown: '## Equipment Stipend' },
          {
            id: 'block-4',
            type: 'paragraph',
            text: 'Every remote employee receives a 1500 USD home office stipend.',
            markdown: 'Every remote employee receives a 1500 USD home office stipend.',
          }
        );
      }
    );

    // Submit v2 for review
    const snap2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/snapshot`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': editor2.id,
        'x-tenant-role': 'member',
      },
    });
    assert.equal(snap2Res.statusCode, 201);
    const v2 = snap2Res.json();
    assert.equal(v2.number, 2);
    assert.equal(v2.status, 'pending_review');

    // Page badge reads "Saved · not indexed (awaiting approval)"
    const pageWhilePending = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/pages/${pageId}`,
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': editor1.id,
          'x-tenant-role': 'member',
        },
      })
    ).json();
    assert.equal(pageWhilePending.badge, 'Saved · not indexed (awaiting approval)');

    // 4. Search and Ask while v2 is pending MUST still cite v1 only!
    const searchWhilePending = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/search',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': editor1.id,
          'x-tenant-role': 'member',
        },
        payload: { query: 'remote policy days per week' },
      })
    ).json();
    assert.equal(searchWhilePending.passages.length > 0, true);
    assert.equal(searchWhilePending.passages[0].versionNumber, 1);
    assert.match(searchWhilePending.passages[0].citeAs, /^Remote Work Policy \(v1, updated \d{4}-\d{2}-\d{2}\)$/);
    assert.equal(
      searchWhilePending.passages.some((p: any) => p.text.includes('1500 USD')),
      false,
      'Unapproved v2 content must not appear in search index'
    );

    // 5. Reviewer approves v2 -> worker indexes v2 (reusing unchanged chunk embeddings) and deletes v1 chunks
    const approveV2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${v2.id}/approve`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': reviewer.id,
        'x-tenant-role': 'member',
      },
      payload: { review_note: 'LGTM, approved v2' },
    });
    assert.equal(approveV2Res.statusCode, 200);
    await runPendingJobsForTenant(tenant.id);

    // Badge is now "Indexed · v2"
    const pageAfterV2 = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/pages/${pageId}`,
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': editor1.id,
          'x-tenant-role': 'member',
        },
      })
    ).json();
    assert.equal(pageAfterV2.badge, 'Indexed · v2');

    // Search and Ask now cite v2!
    const searchAfterApproval = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/search',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': editor1.id,
          'x-tenant-role': 'member',
        },
        payload: { query: '1500 USD home office stipend remote work' },
      })
    ).json();
    assert.equal(searchAfterApproval.passages.length > 0, true);
    assert.equal(searchAfterApproval.passages[0].versionNumber, 2);
    assert.match(searchAfterApproval.passages[0].citeAs, /^Remote Work Policy \(v2, updated \d{4}-\d{2}-\d{2}\)$/);

    const askAfterApproval = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': editor1.id,
          'x-tenant-role': 'member',
        },
        payload: { question: 'What is the home office equipment stipend?' },
      })
    ).json();
    assert.equal(askAfterApproval.foundRelevant, true);
    assert.equal(askAfterApproval.citations[0].versionNumber, 2);
    assert.match(askAfterApproval.answer, /1500 USD/);
  });

  test('Slice 1 Lifecycle Guards: Agent changes always require review, superseding pending snapshots, parent_cycle, and has_children', async () => {
    const { tenant, owner } = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        payload: {
          name: 'Orbit AI',
          slug: 'orbit-ai',
          owner_email: 'ceo@orbit.ai',
          owner_name: 'Orion CEO',
        },
      })
    ).json();

    // Create a NO-REVIEW space (review_required = false)
    const openSpace = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/spaces',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': owner.id,
          'x-tenant-role': 'owner',
        },
        payload: { name: 'General Wiki', slug: 'general', review_required: false },
      })
    ).json();

    // Human creates a page in a no-review space -> goes straight to indexing -> Indexed · v1
    const parentPage = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': owner.id,
          'x-tenant-role': 'owner',
        },
        payload: {
          space_id: openSpace.id,
          title: 'Architecture Overview',
          slug: 'architecture',
          markdown: 'Human authored architecture v1.',
        },
      })
    ).json().document;

    const v1 = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/pages/${parentPage.id}/snapshot`,
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': owner.id,
          'x-tenant-role': 'owner',
        },
      })
    ).json();
    assert.equal(v1.status, 'indexing');
    await runPendingJobsForTenant(tenant.id);

    // Grant an external agent editor access to the no-review space
    const agentId = '00000000-0000-0000-0000-000000000777';
    await app.inject({
      method: 'POST',
      url: `/api/v1/spaces/${openSpace.id}/grants`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': owner.id,
        'x-tenant-role': 'owner',
      },
      payload: { principal_type: 'agent', principal_id: agentId, role: 'editor' },
    });

    // Rule S3: Agent edits the page -> even in a no-review space, agent changes ALWAYS wait for human approval!
    const agentSession = await collabServer.openSession({
      documentName: `${tenant.id}:${parentPage.id}`,
      token: `agent:${agentId}:member`,
    });
    await agentSession.transact(
      { source: 'agent', actorId: agentId, changedBlockIds: ['block-1'] },
      (ydoc: any) => {
        ydoc.blocks = [
          {
            id: 'block-1',
            type: 'paragraph',
            text: 'Agent updated architecture v2.',
            markdown: 'Agent updated architecture v2.',
          },
        ];
      }
    );

    const v2Agent = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/pages/${parentPage.id}/snapshot`,
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'agent',
          'x-principal-id': agentId,
        },
      })
    ).json();
    assert.equal(
      v2Agent.status,
      'pending_review',
      'Agent change must always require human approval even in a space with review_required=false'
    );

    // Create a child page under parentPage
    const childPage = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers: {
          'x-tenant-id': tenant.id,
          'x-principal-type': 'user',
          'x-principal-id': owner.id,
          'x-tenant-role': 'owner',
        },
        payload: {
          space_id: openSpace.id,
          parent_id: parentPage.id,
          title: 'Database Layer',
          slug: 'db-layer',
          markdown: 'Postgres 17 + pgvector 0.8.',
        },
      })
    ).json().document;

    // Moving parentPage under childPage must fail with 409 parent_cycle
    const cycleRes = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${parentPage.id}/move`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': owner.id,
        'x-tenant-role': 'owner',
      },
      payload: {
        target_space_id: openSpace.id,
        target_parent_id: childPage.id,
      },
    });
    assert.equal(cycleRes.statusCode, 409);
    assert.equal(cycleRes.json().error, 'parent_cycle');

    // Archiving parentPage while childPage is active must fail with 409 has_children
    const archiveWithChildrenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${parentPage.id}/archive`,
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': owner.id,
        'x-tenant-role': 'owner',
      },
    });
    assert.equal(archiveWithChildrenRes.statusCode, 409);
    assert.equal(archiveWithChildrenRes.json().error, 'has_children');
  });
});
