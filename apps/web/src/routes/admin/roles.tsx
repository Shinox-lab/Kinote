import { CAPABILITY_GROUPS, ROLE_RULES, ROLE_SUMMARY, SPACE_ROLES, TENANT_ROLE_INFO, roleCan } from '../../lib/roles.js';
import { Card, RoleBadge } from '../../components/ui.js';

/** `/w/$tenantSlug/admin/roles`: a read-only reference for what each role can do. */
export function RolesPage() {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        Access is granted per space. Each role includes everything the roles before it can do. Use{' '}
        <span className="font-medium text-fg">Spaces → Manage access</span> to give someone a role.
      </p>

      <ul aria-label="Space roles" className="grid gap-3 sm:grid-cols-2">
        {SPACE_ROLES.map((role) => (
          <li key={role} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3">
            <RoleBadge role={role} />
            <p className="text-sm text-muted">{ROLE_SUMMARY[role]}</p>
          </li>
        ))}
      </ul>

      <section aria-labelledby="matrix-title" className="flex flex-col gap-2">
        <h2 id="matrix-title" className="text-base font-semibold text-fg">
          What each space role can do
        </h2>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[540px] border-collapse text-sm">
            <thead>
              <tr className="bg-sidebar text-left">
                <th scope="col" className="px-3 py-2 font-medium text-muted">
                  Capability
                </th>
                {SPACE_ROLES.map((role) => (
                  <th key={role} scope="col" className="w-24 px-2 py-2 text-center">
                    <RoleBadge role={role} />
                  </th>
                ))}
              </tr>
            </thead>
            {CAPABILITY_GROUPS.map((group) => (
              <tbody key={group.title}>
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={SPACE_ROLES.length + 1}
                    className="border-t border-line bg-page px-3 pb-1 pt-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted"
                  >
                    {group.title}
                  </th>
                </tr>
                {group.items.map((item) => (
                  <tr key={item.label} className="border-t border-line">
                    <th scope="row" className="px-3 py-2 text-left font-normal text-fg">
                      {item.label}
                      {item.note && <span className="block text-xs text-muted">{item.note}</span>}
                    </th>
                    {SPACE_ROLES.map((role) => {
                      const can = roleCan(role, item);
                      return (
                        <td key={role} className="px-2 py-2 text-center">
                          {can ? (
                            <span className="font-semibold text-success" role="img" aria-label="Can">
                              ✓
                            </span>
                          ) : (
                            <span className="text-faint" role="img" aria-label="Cannot">
                              –
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </section>

      <section aria-labelledby="tenant-title" className="flex flex-col gap-2">
        <h2 id="tenant-title" className="text-base font-semibold text-fg">
          Workspace roles
        </h2>
        <p className="text-sm text-muted">These apply to the whole workspace and sit above space roles.</p>
        <dl className="divide-y divide-line rounded-lg border border-line bg-surface">
          {TENANT_ROLE_INFO.map((info) => (
            <div key={info.role} className="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:gap-4">
              <dt className="w-20 shrink-0 text-sm font-medium text-fg">{info.label}</dt>
              <dd className="text-sm text-muted">{info.summary}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Card title="Good to know">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
          {ROLE_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
