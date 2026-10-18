import { ERROR_SENTENCES, type ErrorCode } from '@living-wiki/contracts';

export function formatApiError(code: ErrorCode | string): string {
  if (code in ERROR_SENTENCES) {
    return ERROR_SENTENCES[code as ErrorCode];
  }
  return 'An unexpected error occurred. Please try again.';
}

export interface PageHeaderProps {
  title: string;
  badge: string;
  reviewRequired: boolean;
  onActionClick: () => void;
}

export function renderPageHeaderModel(props: PageHeaderProps) {
  const primaryButtonLabel = props.reviewRequired ? 'Submit for review' : 'Index now';
  const isRejection = props.badge.includes('rejected');
  return {
    title: props.title,
    badgeText: props.badge,
    primaryActionLabel: primaryButtonLabel,
    showRestoreIndexedButton: isRejection,
  };
}
