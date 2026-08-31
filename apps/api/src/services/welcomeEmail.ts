import pool from '../db/client';

export async function getSchoolName(schoolId: string): Promise<string> {
  const r = await pool.query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolId]);
  return r.rows[0]?.name ?? 'your school';
}

export interface WelcomeEmailOptions {
  role: string;
  name: string;
  email: string;
  tempPassword: string;
  schoolName: string;
  appUrl: string;
  /** How the role is introduced. 'registered' (Students & Parents' wording,
   *  the default) reads "You have been registered on Chronix Edu as a X for
   *  Y."; 'added' (Staff/Users' wording) reads "You have been added as a X
   *  on Chronix Edu for Y." */
  introVerb?: 'registered' | 'added';
  /** Extra line inserted directly after the "change your password"
   *  instruction, before the trailing blank line — e.g. Students & Parents'
   *  portal description. Omitted entirely (no extra line, no extra blank
   *  line) for flows that don't need one. */
  extraLine?: string;
}

export function welcomeEmailBody(opts: WelcomeEmailOptions): string {
  const { role, name, email, tempPassword, schoolName, appUrl, extraLine, introVerb = 'registered' } = opts;
  const intro = introVerb === 'registered'
    ? `You have been registered on Chronix Edu as a ${role} for ${schoolName}.`
    : `You have been added as a ${role} on Chronix Edu for ${schoolName}.`;
  return [
    `Hello ${name},`,
    '',
    intro,
    '',
    'Your login credentials:',
    `  Email:    ${email}`,
    `  Password: ${tempPassword}`,
    '',
    `Log in here: ${appUrl}/login`,
    '',
    'IMPORTANT: Please change your password immediately after your first login.',
    ...(extraLine ? [extraLine] : []),
    '',
    'If you did not expect this email, please contact your school administrator.',
    '',
    '— Chronix Edu',
  ].join('\n');
}
