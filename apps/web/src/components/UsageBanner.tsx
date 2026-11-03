import { useUsage } from '../lib/queries.js';
import { bannerText } from '../lib/usage.js';

/** The credit banner at the top of the console: shown from 80% of the month's AI credits, for everyone in the workspace. */
export function UsageBanner() {
  const usage = useUsage();
  const text = usage.data ? bannerText(usage.data) : null;
  if (!usage.data || !text) return null;
  const refused = usage.data.state === 'exhausted';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm ${
        refused ? 'border border-danger bg-danger-bg text-danger' : 'bg-warn-bg text-warn-text'
      }`}
    >
      <span>{text}</span>
      {usage.data.billingUrl && (
        <a href={usage.data.billingUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline">
          Upgrade
        </a>
      )}
    </div>
  );
}
