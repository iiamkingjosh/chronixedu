/**
 * The system account (migration 053, 2 Oct 2026) is defined once, in config/systemActor.ts, and
 * written in three places: the migration (production), the DB suite's seed and the integration
 * fixture (both of which must put it back after the DB suite's TRUNCATE). These checks keep the three
 * in step with the constant, and keep "whichever super_admin comes first" from coming back.
 */
import fs from 'fs';
import path from 'path';
import { SYSTEM_ACTOR, SYSTEM_ACTOR_ID, isSystemActor } from '../config/systemActor';

const API = path.join(__dirname, '..', '..');
const REPO = path.join(API, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

describe('the system account', () => {
  it('migration 053 creates it with the constant\'s values, inactive, and pins it inactive', () => {
    const sql = read(REPO, 'migrations', '053_system_actor.sql');
    const insert = sql.match(/INSERT INTO users[\s\S]*?ON CONFLICT \(id\) DO NOTHING;/)?.[0] ?? '';
    expect(insert).not.toBe('');
    for (const v of [SYSTEM_ACTOR.id, SYSTEM_ACTOR.email, SYSTEM_ACTOR.firstName, SYSTEM_ACTOR.lastName]) {
      expect(insert).toContain(`'${v}'`);
    }
    expect(insert).toMatch(/'super_admin', 'Chronix', 'System', false, false\)/);
    expect(sql).toContain(`CHECK (id <> '${SYSTEM_ACTOR_ID}'::uuid OR is_active = false)`);
  });

  it('both test fixtures put it back with the constant, since the DB suite\'s seed truncates users', () => {
    for (const file of [path.join(API, 'src', '__db_tests__', 'helpers.ts'), path.join(API, 'jest.globalSetup.ts')]) {
      const src = fs.readFileSync(file, 'utf8');
      expect({ file, imports: /import \{ SYSTEM_ACTOR \} from '[^']*config\/systemActor'/.test(src) }).toEqual({ file, imports: true });
      expect(src).toMatch(/\[SYSTEM_ACTOR\.id, SYSTEM_ACTOR\.email, SYSTEM_ACTOR\.firstName, SYSTEM_ACTOR\.lastName\]/);
    }
  });

  it('isSystemActor knows it, and nothing else', () => {
    expect(isSystemActor(SYSTEM_ACTOR_ID)).toBe(true);
    expect(isSystemActor('00000000-0000-4000-8000-00000000c0df')).toBe(false);
    expect(isSystemActor(null)).toBe(false);
    expect(isSystemActor(undefined)).toBe(false);
  });

  it('no code picks "the first super_admin" any more', () => {
    // The shape that signed Chronix High School's 8 Sep suspension with a test fixture's id.
    const firstAdmin = /role\s*=\s*'super_admin'[^`]*\bLIMIT\s+1\b/;
    // The control: the pattern matches the query it replaced.
    expect(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`).toMatch(firstAdmin);

    // Code only: the comments that explain the fix quote the old query.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The second control: a comment quoting it is not flagged, the same query in code is.
    expect(code(`/** was \`role = 'super_admin' LIMIT 1\` */\nconst ok = 1;`)).not.toMatch(firstAdmin);
    expect(code(`// note\nawait q(\`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1\`);`)).toMatch(firstAdmin);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['__tests__', '__db_tests__'].includes(e.name)) walk(full); continue; }
        if (e.name.endsWith('.ts') && firstAdmin.test(code(fs.readFileSync(full, 'utf8')))) offenders.push(path.relative(API, full));
      }
    };
    walk(path.join(API, 'src'));
    expect(offenders).toEqual([]);
  });
});
