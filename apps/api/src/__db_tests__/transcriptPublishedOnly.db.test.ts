/**
 * A transcript carries published results only, graded as the class is graded (audit, 8 Oct 2026).
 *
 * The transcript is the document a student takes to another school. It took every term with
 * scores, so marks still being entered, or returned for correction, went out as final results
 * (doctrine 5 says published, and only published, leaves the school). It graded them against the
 * school-wide scale, ignoring a level's own scale, which the report card for the same term used.
 */
import request from 'supertest';
import { buildApp, seed, setGradingScale, tokens, IDS as I, pool } from './helpers';
import { transcriptSessions } from '../services/transcriptService';
import { updateAcademicConfig } from '../db/queries/schools';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const TODAY = new Date('2026-12-30T12:00:00Z'); // after First Term began

const fullMarks = () => [I.s1, I.s2].flatMap(student_id => [
  { student_id, component_id: I.ca1, score: 25 },
  { student_id, component_id: I.exam, score: 60 },
]);

async function submitAndApprove() {
  for (const [tok, subject] of [[tokens.math(), I.math], [tokens.english(), I.english]] as const) {
    await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tok)
      .send({ subject_id: subject, class_id: I.jss2a, term_id: I.termA, entries: fullMarks() });
    await request(app).post(`${base}/results/submit`).set('Authorization', tok)
      .send({ class_id: I.jss2a, subject_id: subject, term_id: I.termA });
  }
  const approved = await request(app).post(`${base}/results/approve`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA });
  expect(approved.status).toBe(200);
}

beforeEach(async () => { await seed(); await setGradingScale(I.schoolA); });
afterAll(() => pool.end());

it('leaves out a term whose results are approved but not published', async () => {
  await submitAndApprove();
  expect(await transcriptSessions(I.s1, I.schoolA, TODAY)).toEqual([]);
});

it('includes the term once published, graded on the scale of the class’s level', async () => {
  // JSS 2A is "Junior". Its own scale prints "P" for any mark; the school-wide one would print C (57).
  await updateAcademicConfig(I.schoolA, {
    level_overrides: { Junior: { grading_scale: [{ grade: 'P', min: 0, max: 100, label: 'Pass', remark: '' }] } },
  });
  await submitAndApprove();
  const published = await request(app).post(`${base}/results/publish`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA });
  expect(published.status).toBe(200);

  const sessions = await transcriptSessions(I.s1, I.schoolA, TODAY);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].terms.map(t => t.termName)).toEqual(['First Term']);
  const term = sessions[0].terms[0];
  expect(term.subjects.map(s => [s.name, s.totalScore, s.grade])).toEqual([
    ['English', '57.00', 'P'],
    ['Mathematics', '57.00', 'P'],
  ]);
  expect(term.overall.grade).toBe('P');
});
