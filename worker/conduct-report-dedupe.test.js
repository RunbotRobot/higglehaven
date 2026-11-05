// #3122: voice and nearby-chat conduct reports collapse per (reporter,
// reported) pair, like product_flags' UNIQUE (template_id, flagger_builder_id).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function signupIdVerifiedBuilder(label) {
  const builder = await signupBuilder(label);
  await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)")
    .bind(builder.builderId).run();
  return builder;
}

const SURFACES = [
  { name: 'voice', path: '/voice/report', table: 'voice_conduct_reports', kind: 'voice-report' },
  { name: 'nearby chat', path: '/nearby-chat/report', table: 'nearby_chat_reports', kind: 'nearby-chat-report' },
];

for (const surface of SURFACES) {
  describe(`${surface.name} conduct report one-per-reporter rule (#3122)`, () => {
    async function report(reporter, reportedBuilderId, reason) {
      return api(surface.path, reporter.session({
        method: 'POST', body: JSON.stringify(reason === undefined ? { reportedBuilderId } : { reportedBuilderId, reason }),
      }));
    }
    const rowCount = async (reporterId, reportedId) => (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${surface.table} WHERE reporter_builder_id = ? AND reported_builder_id = ?`,
    ).bind(reporterId, reportedId).first()).n;
    const cardsAbout = async (builderId) => (await env.DB.prepare(
      'SELECT * FROM control_room_tasks WHERE kind = ? AND note LIKE ? ORDER BY created_at',
    ).bind(surface.kind, `%(${builderId})%`).all()).results;

    it('collapses repeats into one row and one card, appending to the existing card, with an identical response shape', async () => {
      const alice = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-repeat-alice`);
      const bob = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-repeat-bob`);
      const first = await report(alice, bob.builderId, 'first incident');
      expect(first.response.status).toBe(201);
      const second = await report(alice, bob.builderId, 'second incident');
      const third = await report(alice, bob.builderId);
      for (const repeat of [second, third]) {
        expect(repeat.response.status).toBe(201);
        expect(Object.keys(repeat.body)).toEqual(['reportId']);
        expect(repeat.body.reportId).toBe(first.body.reportId);
      }
      expect(await rowCount(alice.builderId, bob.builderId)).toBe(1);
      // #3121: the reported account's user_id is still recorded on the surviving row.
      const stored = await env.DB.prepare(`SELECT reported_user_id FROM ${surface.table} WHERE report_id = ?`).bind(first.body.reportId).first();
      expect(stored.reported_user_id).toBeTruthy();
      const cards = await cardsAbout(bob.builderId);
      expect(cards).toHaveLength(1);
      expect(cards[0].task_id).toBe(first.body.reportId);
      expect(cards[0].note).toContain('first incident');
      expect(cards[0].note).toContain('Repeat report from the same reporter');
      expect(cards[0].note).toContain('Reason: second incident');
    });

    it('re-queues a card an admin already marked done, so a new report is not lost', async () => {
      const alice = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-done-alice`);
      const bob = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-done-bob`);
      const first = await report(alice, bob.builderId);
      await env.DB.prepare("UPDATE control_room_tasks SET status = 'done' WHERE task_id = ?").bind(first.body.reportId).run();
      await report(alice, bob.builderId, 'happened again');
      const card = await env.DB.prepare('SELECT status, note FROM control_room_tasks WHERE task_id = ?').bind(first.body.reportId).first();
      expect(card.status).toBe('queued');
      expect(card.note).toContain('happened again');
    });

    it('still files separately for a different reporter against the same builder, and for the same reporter against a different builder', async () => {
      const alice = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-pair-alice`);
      const carol = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-pair-carol`);
      const bob = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-pair-bob`);
      const dave = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-pair-dave`);
      const ids = new Set();
      for (const [reporter, reported] of [[alice, bob], [carol, bob], [alice, dave]]) {
        const created = await report(reporter, reported.builderId);
        expect(created.response.status).toBe(201);
        ids.add(created.body.reportId);
      }
      expect(ids.size).toBe(3);
      expect(await cardsAbout(bob.builderId)).toHaveLength(2);
      expect(await cardsAbout(dave.builderId)).toHaveLength(1);
    });

    it('leaves exactly one row and one card when the same report is submitted concurrently', async () => {
      const alice = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-race-alice`);
      const bob = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-race-bob`);
      const results = await Promise.all([1, 2, 3, 4].map(() => report(alice, bob.builderId)));
      for (const result of results) expect(result.response.status).toBe(201);
      expect(await rowCount(alice.builderId, bob.builderId)).toBe(1);
      expect(await cardsAbout(bob.builderId)).toHaveLength(1);
    });

    it('stops growing a card note past the cap, still answering 201', async () => {
      const alice = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-cap-alice`);
      const bob = await signupIdVerifiedBuilder(`dedupe-${surface.kind}-cap-bob`);
      const first = await report(alice, bob.builderId);
      await env.DB.prepare('UPDATE control_room_tasks SET note = note || ? WHERE task_id = ?')
        .bind('x'.repeat(4000), first.body.reportId).run();
      const before = (await env.DB.prepare('SELECT note FROM control_room_tasks WHERE task_id = ?').bind(first.body.reportId).first()).note;
      const repeat = await report(alice, bob.builderId, 'beyond the cap');
      expect(repeat.response.status).toBe(201);
      const after = (await env.DB.prepare('SELECT note FROM control_room_tasks WHERE task_id = ?').bind(first.body.reportId).first()).note;
      expect(after).toBe(before);
    });
  });
}

// The deploy migration must survive duplicates already in production: rebuild
// the pre-0183 state in scratch tables and run the migration's own statements.
describe('migration 0183 over pre-existing duplicates (#3122)', () => {
  it('keeps the earliest row per pair and then enforces uniqueness', async () => {
    for (const table of ['voice_conduct_reports', 'nearby_chat_reports']) {
      const alice = await signupIdVerifiedBuilder(`dedupe-mig-${table}-alice`);
      const bob = await signupIdVerifiedBuilder(`dedupe-mig-${table}-bob`);
      await env.DB.prepare(`DROP INDEX IF EXISTS idx_${table}_pair`).run();
      const insert = (id, at) => env.DB.prepare(
        `INSERT INTO ${table} (report_id, reporter_builder_id, reported_builder_id, created_at) VALUES (?, ?, ?, ?)`,
      ).bind(id, alice.builderId, bob.builderId, at).run();
      await insert('mig-late', '2026-01-03T00:00:00.000Z');
      await insert('mig-early', '2026-01-01T00:00:00.000Z');
      await insert('mig-mid', '2026-01-02T00:00:00.000Z');
      await env.DB.prepare(`
        DELETE FROM ${table}
        WHERE EXISTS (
          SELECT 1 FROM ${table} earlier
          WHERE earlier.reporter_builder_id = ${table}.reporter_builder_id
            AND earlier.reported_builder_id = ${table}.reported_builder_id
            AND (earlier.created_at < ${table}.created_at
              OR (earlier.created_at = ${table}.created_at AND earlier.report_id < ${table}.report_id))
        )
      `).run();
      await env.DB.prepare(`CREATE UNIQUE INDEX idx_${table}_pair ON ${table}(reporter_builder_id, reported_builder_id)`).run();
      const rows = (await env.DB.prepare(`SELECT report_id FROM ${table} WHERE reporter_builder_id = ?`).bind(alice.builderId).all()).results;
      expect(rows.map((row) => row.report_id)).toEqual(['mig-early']);
      await expect(insert('mig-dup', '2026-02-01T00:00:00.000Z')).rejects.toThrow();
    }
  });
});
