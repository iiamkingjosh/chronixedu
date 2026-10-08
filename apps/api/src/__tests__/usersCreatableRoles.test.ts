import fs from 'fs';
import path from 'path';
import { STAFF_ROLES } from '../services/staffBulkImportValidation';

/**
 * Settings → Users creates staff accounts only (8 Oct 2026). The web form cannot import the API's list, so
 * a role offered on one side and refused on the other would be a dead option, or a role the API takes that
 * no screen offers. This reads the web form's list and checks it against the API's, both ways.
 */
describe('Settings → Users offers exactly the roles the API creates', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../web/app/(dashboard)/settings/users/page.tsx'), 'utf8');
  const listed = source.match(/const STAFF_ROLES: StaffRole\[\] = \[([^\]]*)\]/);
  const formEnum = source.match(/role:\s+z\.enum\(\[([^\]]*)\]/);
  const names = (m: RegExpMatchArray | null) => (m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]) : []);

  it('finds both lists it is checking', () => {
    // The control: an unreadable list would make the comparisons below compare nothing.
    expect(names(listed).length).toBeGreaterThan(0);
    expect(names(formEnum).length).toBeGreaterThan(0);
  });

  it('the options and the form validation are the API\'s staff roles, and nothing else', () => {
    expect([...names(listed)].sort()).toEqual([...STAFF_ROLES].sort());
    expect([...names(formEnum)].sort()).toEqual([...STAFF_ROLES].sort());
  });
});
