import { useUsage } from '../lib/queries.js';
import { bannerText } from '../lib/usage.js';

/**
 * The banner at the top of the console, for everyone in the workspace: a billing problem (payment
 * failed, or suspended), else credits from 80% of the month's AI credits.
 */
export function UsageBanner() {
  const usage = useUsage();
  const text = usage.data ? bannerText(usage.data) : null;
  if (!usage.data || !text) return null;
  const billingProblem = usage.data.billingState !== 'ok';
  const refused = usage.data.state === 'exhausted' || usage.data.billingState === 'suspended';
  const link = billingProblem
    ? usage.data.manageUrl && { href: usage.data.manageUrl, label: 'Update billing' }
    : usage.data.billingUrl && { href: usage.data.billingUrl, label: 'Upgrade' };
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm ${
        refused ? 'border border-danger bg-danger-bg text-danger' : 'bg-warn-bg text-warn-text'
      }`}
    >
      <span>{text}</span>
      {link && (
        <a href={link.href} target="_blank" rel="noopener noreferrer" className="font-medium underline">
          {link.label}
        </a>
      )}
    </div>
  );
}
