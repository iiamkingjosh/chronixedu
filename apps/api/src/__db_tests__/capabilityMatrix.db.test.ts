/**
 * Each capability admits exactly the roles the table gives it, at run time (spec
 * docs/superpowers/specs/2026-10-08-roles-permissions-design.md, test 4).
 *
 * One route per capability is called as every role, as a platform admin, and as the principal of another school.
 * A holder is not refused by the guard (any answer but 403 FORBIDDEN: a 400 for an empty body still means the guard
 * let it through); everyone else is. Both directions, because a guard that refuses everyone and one that admits
 * everyone each pass a one-sided test (doctrine 16). The expected answers are read from the table, so the test
 * holds the routes to it, not to a second list.
 *
 * capabilityRoutes.test.ts checks that every route names its capability; this checks that naming it does what the
 * table says. A capability joins ROUTES when the file that serves it moves to the table (Batch 9, tasks 3-9).
 */
import express from 'express';
import request from 'supertest';
import { seed, token, tokens, IDS as I, pool } from './helpers';
import table from '../config/capabilities.json';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import schoolsRoutes from '../routes/schools';
import sessionsRoutes from '../routes/sessions';
import rosterRoutes from '../routes/roster';
import usersRoutes from '../routes/users';
import assessmentConfigRoutes from '../routes/assessmentConfig';
import studentsRoutes from '../routes/students';
import scoresRoutes from '../routes/scores';
import resultsRoutes from '../routes/results';
import dashboardRoutes from '../routes/dashboard';
import teacherDashboardRoutes from '../routes/teacherDashboard';
import attendanceRoutes from '../routes/attendance';
import parentRoutes from '../routes/parent';
import studentRoutes from '../routes/student';
import assignmentsRoutes from '../routes/assignments';
import behaviourRoutes from '../routes/behaviour';
import messagesRoutes from '../routes/messages';
import announcementsRoutes from '../routes/announcements';
import notificationsRoutes from '../routes/notifications';
import feesRoutes from '../routes/fees';
import platformBillingRoutes from '../routes/platformBilling';
import analyticsRoutes from '../routes/analytics';
import timetableRoutes from '../routes/timetable';
import classCommentsRoutes from '../routes/classComments';
import principalRemarksRoutes from '../routes/principalRemarks';
import noticesRoutes from '../routes/notices';

// Every school router, in index.ts's order, behind index.ts's chain.
const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription);
for (const r of [schoolsRoutes, sessionsRoutes, rosterRoutes, usersRoutes, assessmentConfigRoutes, studentsRoutes, scoresRoutes,
  resultsRoutes, dashboardRoutes, teacherDashboardRoutes, attendanceRoutes, parentRoutes, studentRoutes, assignmentsRoutes,
  behaviourRoutes, messagesRoutes, announcementsRoutes, notificationsRoutes, feesRoutes, platformBillingRoutes, analyticsRoutes,
  timetableRoutes, classCommentsRoutes, principalRemarksRoutes, noticesRoutes]) {
  app.use('/api/schools', r);
}
app.use(errorHandler);
const REGISTRAR = '30000000-0000-4000-8000-000000000071';
const BURSAR = '30000000-0000-4000-8000-000000000072';
const ADMIN = 'c0000000-0000-4000-8000-000000000071';

const callers: Record<string, () => string> = {
  principal: tokens.principalA,
  registrar: () => token(REGISTRAR, 'registrar', I.schoolA),
  bursar: () => token(BURSAR, 'bursar', I.schoolA),
  teacher: tokens.math,
  parent: tokens.parentA,
  student: tokens.studentS1,
  platform_admin: () => token(ADMIN, 'super_admin', I.schoolB),
  other_school_principal: tokens.principalB,
};

type Route = { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; body?: object };
const base = `/api/schools/${I.schoolA}`;

/** One route per capability, chosen to change nothing for a caller the guard admits (a read, or a refused body). */
const ROUTES: Partial<Record<keyof typeof table.capabilities, Route>> = {
  'school.setup': { method: 'get', path: `${base}/setup-status` },
  'school.export': { method: 'get', path: `${base}/export` },
  'school.member': { method: 'get', path: `${base}/sessions` },
  'staff.manage': { method: 'get', path: `${base}/users` },
  'staff.email': { method: 'patch', path: `${base}/users/${I.mathTeacher}/email`, body: {} },
  'school.payout.view': { method: 'get', path: `${base}/settings/payout` },
  'school.payout.manage': { method: 'put', path: `${base}/settings/payout`, body: {} },
  'roster.classes_subjects': { method: 'patch', path: `${base}/classes/${I.jss2a}`, body: {} },
  'roster.teaching': { method: 'post', path: `${base}/teacher-assignments`, body: {} },
  'timetable.manage': { method: 'post', path: `${base}/timetable`, body: {} },
  'students.manage': { method: 'post', path: `${base}/students/${I.s1}/class`, body: {} },
  'students.view': { method: 'get', path: `${base}/students` },
  'results.enter': { method: 'post', path: `${base}/scores/bulk-entry`, body: {} },
  'results.manage': { method: 'get', path: `${base}/results/report-cards` },
  'school.overview': { method: 'get', path: `${base}/dashboard/principal/overview` },
  'teacher.workspace': { method: 'get', path: `${base}/dashboard/teacher/notifications` },
  'class.comments': { method: 'put', path: `${base}/class-comments/${I.s1}`, body: {} },
};

beforeAll(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $3, 'registrar@matrix.test', 'x', 'registrar', 'Reg', 'Istrar', true, 'subject', false),
            ($2, $3, 'bursar@matrix.test', 'x', 'bursar', 'Bur', 'Sar', true, 'subject', false)`,
    [REGISTRAR, BURSAR, I.schoolA]);
  // A platform admin who existed before two-factor was required (migration 058): the token's own row must say so.
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, must_change_password, two_factor_required)
     VALUES ($1, NULL, 'admin@matrix.test', 'x', 'super_admin', 'Plat', 'Form', false, false)`, [ADMIN]);
});
afterAll(() => pool.end());

function expected(cap: keyof typeof table.capabilities, caller: string): boolean {
  const row = table.capabilities[cap];
  if (caller === 'platform_admin') return row.platform_admin;
  if (caller === 'other_school_principal') return false;
  return (row.roles as string[]).includes(caller);
}

describe.each(Object.entries(ROUTES))('%s', (cap, route) => {
  it('admits exactly the roles the table gives it', async () => {
    const results: Record<string, boolean> = {};
    for (const [caller, auth] of Object.entries(callers)) {
      const res = await request(app)[route!.method](route!.path).set('Authorization', auth()).send(route!.body ?? {});
      results[caller] = !(res.status === 403 && res.body?.error?.code === 'FORBIDDEN');
    }
    const want = Object.fromEntries(Object.keys(callers).map(c => [c, expected(cap as keyof typeof table.capabilities, c)]));
    expect(results).toEqual(want);
    // Never vacuous: someone is admitted and someone is refused.
    expect(Object.values(want)).toContain(true);
    expect(Object.values(want)).toContain(false);
  });
});
