import { Card, ErrorNote } from '../../components/ui.js';
import { useUsage } from '../../lib/queries.js';
import { bytes, renewsOn, usedOf } from '../../lib/usage.js';

/** Settings -> Usage (owners and admins): this period's credits, index credits, storage and seats against the plan. */
export function UsagePage() {
  const usage = useUsage();
  if (usage.error) return <ErrorNote error={usage.error} />;
  if (!usage.data) return null;
  const u = usage.data;
  const rows: Array<[string, string, string?]> = [
    [
      'AI credits',
      usedOf(u.usedCredits, u.limitCredits),
      u.limitCredits === null
        ? 'Capture and Ask'
        : `Capture and Ask${u.creditsTopup > 0 ? ` · includes ${u.creditsTopup.toLocaleString('en-US')} added this month` : ''}${
            u.graceLeftCredits !== null && u.state !== 'unlimited'
              ? ` · ${Math.floor(u.graceLeftCredits).toLocaleString('en-US')} left before AI actions pause`
              : ''
          }`,
    ],
    ['Indexing credits', usedOf(u.indexUsedCredits, u.indexLimitCredits), u.indexHeld ? 'Indexing limit reached: new pages wait until credits renew.' : 'Search and page indexing'],
    ['Storage', usedOf(u.storageBytes, u.storageLimitBytes, bytes), 'Stored files'],
    ['Seats', usedOf(u.seats, u.seatLimit), 'Members and pending invitations; viewers are free'],
  ];
  return (
    <Card title="Usage">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Plan: <span className="font-medium text-fg">{u.plan}</span> · Renews on {renewsOn(u.resetsAt)}
          {u.billingUrl && (
            <>
              {' · '}
              <a href={u.billingUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">
                Upgrade
              </a>
            </>
          )}
        </p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map(([label, value, note]) => (
            <div key={label} className="rounded-md border border-line p-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
              <dd className="mt-1 text-lg font-semibold text-fg" data-testid={`usage-${label.toLowerCase().replace(/\s+/g, '-')}`}>
                {value}
              </dd>
              {note && <dd className="mt-0.5 text-xs text-muted">{note}</dd>}
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}
